use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use crate::devshell::DevshellCache;

use super::config::StartupCommandConfig;
use super::status::StartupOutputEvent;

pub(super) async fn prepare_devshell_env(
    app: &AppHandle,
    cache: &Arc<DevshellCache>,
    root: &Path,
) -> Result<BTreeMap<String, String>, String> {
    let emitter = crate::devshell::prepare_policy::emitter_for(app);
    let decision = crate::devshell::prepare_env_for_root(app, cache, root, Some(&emitter)).await;
    match decision {
        crate::devshell::PrepareDecision::Disabled
        | crate::devshell::PrepareDecision::MissingOptional { .. } => Ok(BTreeMap::new()),
        crate::devshell::PrepareDecision::Prepared { prepared, .. } => Ok(prepared.env),
        crate::devshell::PrepareDecision::DirenvAllowFailedOptional { reason, .. } => {
            tracing::warn!(
                target: "aethon::startup",
                "startup devshell direnv allow failed for {}: {reason}; continuing with host env",
                root.display()
            );
            Ok(BTreeMap::new())
        }
        crate::devshell::PrepareDecision::CachePrepareFailedOptional { reason, .. } => {
            tracing::warn!(
                target: "aethon::startup",
                "startup devshell prepare failed for {}: {reason}; continuing with host env",
                root.display()
            );
            Ok(BTreeMap::new())
        }
        crate::devshell::PrepareDecision::MissingRequired { reason } => {
            let error =
                crate::devshell::prepare_policy::required_devshell_missing_error("always", reason)
                    .unwrap_or_else(|| "missing required devshell".to_string());
            Err(format!("devshell prepare: {error}"))
        }
        crate::devshell::PrepareDecision::ForcedModeMismatch { reason }
        | crate::devshell::PrepareDecision::CachePrepareFailedRequired { reason } => {
            Err(format!("devshell prepare: {reason}"))
        }
        crate::devshell::PrepareDecision::DirenvAllowFailedRequired { reason } => Err(reason),
    }
}

pub(super) async fn run_startup_command(
    app: &AppHandle,
    root: &Path,
    fingerprint: &str,
    cfg: &StartupCommandConfig,
    devshell_env: &BTreeMap<String, String>,
) -> Result<(), String> {
    let mut command = shell_command(&cfg.command);
    command
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in devshell_env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("{} failed to start: {e}", cfg.label))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = stdout.map(|stream| {
        tokio::spawn(read_command_stream(
            app.clone(),
            root.display().to_string(),
            fingerprint.to_string(),
            cfg.id.clone(),
            cfg.label.clone(),
            "stdout".to_string(),
            stream,
        ))
    });
    let stderr_task = stderr.map(|stream| {
        tokio::spawn(read_command_stream(
            app.clone(),
            root.display().to_string(),
            fingerprint.to_string(),
            cfg.id.clone(),
            cfg.label.clone(),
            "stderr".to_string(),
            stream,
        ))
    });
    let wait = child.wait();
    let status = match tokio::time::timeout(Duration::from_secs(cfg.timeout_seconds), wait).await {
        Ok(result) => result.map_err(|e| format!("{} wait failed: {e}", cfg.label))?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(format!(
                "{} timed out after {}s",
                cfg.label, cfg.timeout_seconds
            ));
        }
    };
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} exited with {}", cfg.label, status))
    }
}

async fn read_command_stream<R: AsyncRead + Unpin>(
    app: AppHandle,
    root: String,
    fingerprint: String,
    task_id: String,
    task_label: String,
    stream: String,
    reader: R,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let content = format!("{line}\n");
        let _ = app.emit(
            "workspace-startup-output",
            StartupOutputEvent {
                root: root.clone(),
                fingerprint: fingerprint.clone(),
                task_id: task_id.clone(),
                task_label: task_label.clone(),
                stream: stream.clone(),
                content,
            },
        );
    }
}

fn shell_command(script: &str) -> tokio::process::Command {
    if cfg!(windows) {
        let mut command = crate::env::tokio_command("cmd");
        command.args(["/C", script]);
        command
    } else {
        let mut command = crate::env::tokio_command("sh");
        command.args(["-lc", script]);
        command
    }
}
