//! `install_aethon_extension` — shells out to `npm install --prefix
//! ~/.aethon/skills <spec>`. Running this in the Tauri shell avoids
//! the agent sidecar being killed mid-install by the existing
//! `node_modules` watcher; on success we still terminate the current
//! agent children so the next request respawns with the freshly
//! installed package loaded.

use std::process::Stdio;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent_process::AgentProcesses;
use crate::env;

fn validate_extension_install_spec(spec: &str) -> Result<String, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("extension install spec is required".to_string());
    }
    if trimmed.len() > 512 {
        return Err("extension install spec is too long".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("extension install spec cannot start with '-'".to_string());
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("extension install spec must be a single package or git URL".to_string());
    }
    Ok(trimmed.to_string())
}

fn output_tail(stdout: &[u8], stderr: &[u8]) -> String {
    let mut text = String::new();
    let out = String::from_utf8_lossy(stdout);
    let err = String::from_utf8_lossy(stderr);
    if !out.trim().is_empty() {
        text.push_str(out.trim());
    }
    if !err.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(err.trim());
    }
    const MAX: usize = 4000;
    if text.len() <= MAX {
        text
    } else {
        let mut tail = text.chars().rev().take(MAX).collect::<Vec<_>>();
        tail.reverse();
        tail.into_iter().collect()
    }
}

/// Install an Aethon npm extension package from inside the app. The spec can
/// be a normal npm package name, tarball URL, GitHub shorthand, or git URL —
/// exactly what `npm install <spec>` accepts. Running this in the Tauri shell
/// avoids the agent sidecar being killed mid-install by the existing
/// node_modules watcher. On success we still terminate the current agent so
/// the next request respawns with the freshly installed package loaded.
#[tauri::command]
pub async fn install_aethon_extension(
    spec: String,
    app: AppHandle,
    state: State<'_, AgentProcesses>,
) -> Result<String, String> {
    let spec = validate_extension_install_spec(&spec)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let skills_dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?
        .join("skills");
    let install_dir = skills_dir.clone();
    let install_spec = spec.clone();
    let path_override = env::resolved_login_path();

    let install_result = tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("create {}: {e}", install_dir.display()))?;
        let mut command = env::command("npm");
        command
            .arg("install")
            .arg("--prefix")
            .arg(&install_dir)
            .arg(&install_spec)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = path_override {
            command.env("PATH", path);
        }
        let output = command
            .output()
            .map_err(|e| format!("npm install failed to start: {e}"))?;
        let tail = output_tail(&output.stdout, &output.stderr);
        if !output.status.success() {
            let status = output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            return Err(format!("npm install exited {status}: {tail}"));
        }
        Ok(tail)
    })
    .await
    .map_err(|e| format!("install task failed: {e}"))?;

    let install_output = install_result?;
    let children: Vec<_> = state
        .children
        .lock()
        .map(|mut guard| guard.drain().collect())
        .unwrap_or_default();
    if !children.is_empty() {
        if let Ok(mut exits) = state.intentional_exits.lock() {
            for (key, _) in &children {
                exits.insert(key.clone());
            }
        }
        for (key, child) in children {
            if let Ok(mut child) = child.lock() {
                let pid = child.id();
                let _ = child.kill();
                let _ = child.wait();
                tracing::info!(target: "aethon::ext_install", key = key, "killed pid={pid}; will respawn with {spec}");
            }
        }
        if let Ok(mut routes) = state.mutation_routes.lock() {
            routes.clear();
        }
        let _ = app.emit("agent-reloaded", "");
    }

    Ok(if install_output.trim().is_empty() {
        format!("Installed {spec}")
    } else {
        install_output
    })
}
