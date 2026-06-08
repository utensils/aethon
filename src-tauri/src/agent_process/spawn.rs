//! Spawning the agent child process.
//!
//! Builds the right `Command` for dev (`bun run agent/main.ts` from the
//! project root) vs release (the bundled sidecar binary), enriches its
//! env with docs / layout / user-state pointers, fires it up with
//! piped stdio, and hands stdout/stderr to the reader threads in
//! [`super::readers`]. Idempotent: if a live child is already held for
//! the given key the call is a no-op; if the previous child has exited
//! it's collected and a fresh one is spawned.

use std::collections::{HashMap, HashSet, VecDeque};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

use crate::helpers::parse_config_toml;
use crate::{env, helpers};

use std::time::Instant;

use super::process::{AgentWorker, WorkerMeta};
use super::readers::{
    STDERR_TAIL_CAP, StderrReaderCtx, StdoutReaderCtx, spawn_stderr_reader, spawn_stdout_reader,
};
use super::sidecar::{find_sidecar_binary, project_root};

/// Spawn the agent if no live child is held. Idempotent. Callers own the
/// mutex around this. In dev (`debug_assertions`) we run `bun run
/// agent/main.ts` from the project root. In release we run the bundled
/// `aethon-agent` sidecar and enrich its env with docs, layout, user-state,
/// and PATH information.
pub(super) fn ensure_agent_spawned(
    guard: &mut HashMap<String, Arc<Mutex<Child>>>,
    key: &str,
    app: &AppHandle,
    mutation_routes: Arc<Mutex<HashMap<String, String>>>,
    intentional_exits: Arc<Mutex<HashSet<String>>>,
    meta: Arc<Mutex<HashMap<String, WorkerMeta>>>,
    worker: Option<AgentWorker>,
) -> Result<(), String> {
    let exited_status = guard.get(key).and_then(|child| {
        child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok().flatten())
    });
    if let Some(status) = exited_status {
        tracing::info!(target: "aethon::agent", key = key, "previous child exited with {status:?}; respawning");
        guard.remove(key);
    }

    if should_respawn_for_worker_cwd(key, &meta, worker.as_ref())
        && let Some(child) = guard.remove(key)
    {
        tracing::info!(
            target: "aethon::agent",
            key = key,
            "worker cwd changed; respawning agent"
        );
        if let Ok(mut exits) = intentional_exits.lock() {
            exits.insert(key.to_string());
        }
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(mut map) = meta.lock() {
            map.remove(key);
        }
    }

    if guard.contains_key(key) {
        return Ok(());
    }

    let mut command = build_command(app)?;
    apply_user_env(app, &mut command);
    apply_worker_env(&mut command, worker.as_ref());
    clear_inherited_devshell_identity(&mut command, worker.as_ref());
    apply_worker_devshell_env(app, &mut command, worker.as_ref());
    apply_worker_current_dir(&mut command, worker.as_ref());

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn agent: {e}"))?;

    let pid = child.id();
    tracing::info!(target: "aethon::agent", key = key, "spawned pid={pid}");

    let stderr_tail: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_CAP)));

    let stdout = child.stdout.take().ok_or("no stdout on spawned agent")?;
    spawn_stdout_reader(StdoutReaderCtx {
        stdout,
        app: app.clone(),
        pid,
        key: key.to_string(),
        tab_id: worker.as_ref().map(|w| w.tab_id.clone()),
        mutation_routes,
        intentional_exits,
        meta: Arc::clone(&meta),
        stderr_tail: Arc::clone(&stderr_tail),
    });

    let stderr = child.stderr.take().ok_or("no stderr on spawned agent")?;
    spawn_stderr_reader(StderrReaderCtx {
        stderr,
        app: app.clone(),
        pid,
        key: key.to_string(),
        stderr_tail,
        meta: Arc::clone(&meta),
    });

    {
        let now = Instant::now();
        let (tab_id, cwd) = worker
            .as_ref()
            .map(|w| (Some(w.tab_id.clone()), w.cwd.clone()))
            .unwrap_or((None, None));
        if let Ok(mut map) = meta.lock() {
            map.insert(
                key.to_string(),
                WorkerMeta {
                    tab_id,
                    cwd,
                    pid,
                    spawned_at: now,
                    last_activity: now,
                    prompt_in_flight: false,
                    bridge_ready: key == super::process::GLOBAL_AGENT_KEY,
                },
            );
        }
    }

    // Bridge processes start with `frontendReady = false` and only
    // flip it when the dispatcher receives `{"type":"report"}`. The
    // React tree sends one such message on mount, but `route_payload_key`
    // pins it to `__global__` — workers would otherwise stay un-ready
    // forever and `sendQuery` (e.g. devshell `env_for_path`) would race
    // against a 5s timeout. Synthesise the handshake here so every
    // bridge — global and per-tab — comes up ready. Metadata is registered
    // first so any immediate stdout readiness marker can be recorded.
    if let Some(stdin) = child.stdin.as_mut()
        && let Err(e) = inject_initial_handshake(stdin)
    {
        tracing::warn!(
            target: "aethon::agent",
            key = key,
            "failed to inject initial handshake: {e}"
        );
    }

    guard.insert(key.to_string(), Arc::new(Mutex::new(child)));
    Ok(())
}

fn build_command(app: &AppHandle) -> Result<Command, String> {
    if cfg!(debug_assertions) {
        let root = project_root();
        let docs_dir = root.join("docs").join("aethon-agent");
        let boot_layout_file = root
            .join("src")
            .join("extensions")
            .join("default-layout")
            .join("workstation.a2ui.json");
        let layout_slots_file = root
            .join("src")
            .join("extensions")
            .join("default-layout")
            .join("slots.json");
        let mut c = env::command("bun");
        c.current_dir(&root)
            .arg("run")
            .arg(root.join("agent").join("main.ts"));
        c.env("AETHON_RELEASE_MODE", "0");
        c.env("AETHON_PROJECT_ROOT", &root);
        c.env("AETHON_DOCS_DIR", &docs_dir);
        c.env("AETHON_BOOT_LAYOUT_FILE", &boot_layout_file);
        c.env("AETHON_LAYOUT_SLOTS_FILE", &layout_slots_file);
        Ok(c)
    } else {
        let bin = find_sidecar_binary()?;
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {e}"))?;
        let pi_dir = resource_dir.join("pi");
        let docs_dir = resource_dir.join("docs").join("aethon-agent");
        let boot_layout_file = resource_dir
            .join("extensions")
            .join("default-layout")
            .join("workstation.a2ui.json");
        let layout_slots_file = resource_dir
            .join("extensions")
            .join("default-layout")
            .join("slots.json");
        let mut c = Command::new(&bin);
        c.env("PI_PACKAGE_DIR", &pi_dir);
        c.env("AETHON_RELEASE_MODE", "1");
        c.env("AETHON_DOCS_DIR", &docs_dir);
        c.env("AETHON_BOOT_LAYOUT_FILE", &boot_layout_file);
        c.env("AETHON_LAYOUT_SLOTS_FILE", &layout_slots_file);
        if let Some(path) = env::resolved_login_path() {
            c.env("PATH", path);
        }
        Ok(c)
    }
}

fn apply_user_env(app: &AppHandle, command: &mut Command) {
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let user_dir = helpers::aethon_dir(Some(home.clone())).unwrap_or_else(|| home.join(".aethon"));
    let state_file = user_dir.join("state.json");
    let sessions_dir = user_dir.join("sessions");
    command.env("AETHON_USER_DIR", &user_dir);
    command.env("AETHON_STATE_FILE", &state_file);
    command.env("AETHON_SESSIONS_DIR", &sessions_dir);

    let cfg_path = user_dir.join("config.toml");
    let raw = std::fs::read_to_string(&cfg_path).unwrap_or_default();
    let cfg_json = parse_config_toml(&raw);
    let warn_kb = cfg_json["extensions"]["stateWarnKb"].as_u64().unwrap_or(64);
    let hard_kb = cfg_json["extensions"]["stateHardKb"]
        .as_u64()
        .unwrap_or(512);
    command.env("AETHON_STATE_WARN_KB", warn_kb.to_string());
    command.env("AETHON_STATE_HARD_KB", hard_kb.to_string());
    if let Some(provider_timeout) = cfg_json["agent"]["providerTimeoutSeconds"].as_u64() {
        command.env(
            "AETHON_PROVIDER_TIMEOUT_SECONDS",
            provider_timeout.to_string(),
        );
    }
    let bash_timeout_floor = cfg_json["agent"]["bashTimeoutFloorSeconds"]
        .as_u64()
        .unwrap_or(crate::helpers::AGENT_TIMEOUT_SECONDS_DEFAULT as u64);
    let subagent_timeout = cfg_json["agent"]["subagentTimeoutSeconds"]
        .as_u64()
        .unwrap_or(crate::helpers::AGENT_TIMEOUT_SECONDS_DEFAULT as u64);
    command.env(
        "AETHON_BASH_TIMEOUT_FLOOR_SECONDS",
        bash_timeout_floor.to_string(),
    );
    command.env(
        "AETHON_SUBAGENT_TIMEOUT_SECONDS",
        subagent_timeout.to_string(),
    );

    // Guardrails: the soft anchor is appended to the per-turn working-context
    // the agent injects; the hard-enforce default is consumed by the agent's
    // source-guard wrapper (per-tab overridable at runtime). Only emit the
    // anchor when present so the agent can distinguish "unset" from "empty".
    if let Some(anchor) = cfg_json["guardrails"]["softPromptAnchor"].as_str()
        && !anchor.trim().is_empty()
    {
        command.env("AETHON_SOFT_GUARDRAIL_PROMPT", anchor);
    }
    let hard_enforce = cfg_json["guardrails"]["hardEnforceProjectRoot"]
        .as_bool()
        .unwrap_or(false);
    command.env(
        "AETHON_HARD_ENFORCE_PROJECT_ROOT",
        if hard_enforce { "1" } else { "0" },
    );
}

fn apply_worker_env(command: &mut Command, worker: Option<&AgentWorker>) {
    let Some(worker) = worker else {
        return;
    };
    command.env("AETHON_WORKER_TAB_ID", &worker.tab_id);
    if let Some(cwd) = &worker.cwd
        && !cwd.is_empty()
    {
        command.env("AETHON_WORKER_CWD", cwd);
    }
}

fn clear_inherited_devshell_identity(command: &mut Command, worker: Option<&AgentWorker>) {
    if worker.is_none() {
        return;
    }
    for key in [
        "IN_NIX_SHELL",
        "DEVSHELL_DIR",
        "NIX_BUILD_TOP",
        "NIX_ENFORCE_PURITY",
        "name",
    ] {
        command.env_remove(key);
    }
    command.env("PATH", env::resolved_project_path());
}

fn apply_worker_devshell_env(app: &AppHandle, command: &mut Command, worker: Option<&AgentWorker>) {
    let Some(cwd) = worker
        .and_then(|w| w.cwd.as_deref())
        .filter(|cwd| !cwd.is_empty())
    else {
        return;
    };
    let cwd = std::path::PathBuf::from(cwd);
    let (enabled, configured_mode) = crate::commands::devshell::effective_config(app, &cwd);
    if enabled == "never" {
        return;
    }
    let cache = app.state::<Arc<crate::devshell::DevshellCache>>();
    let Some(prepared) = cache.ready_env_now(&cwd, configured_mode) else {
        tracing::warn!(
            target: "aethon::devshell",
            "agent worker spawn for {} did not find a ready devshell env",
            cwd.display()
        );
        return;
    };
    tracing::debug!(
        target: "aethon::devshell",
        "applying {} devshell vars to agent worker {}",
        prepared.env.len(),
        cwd.display()
    );
    command.env("AETHON_WORKER_DEVSHELL_READY", "1");
    let prepared_keys: Vec<String> = prepared.env.keys().cloned().collect();
    if let Ok(keys_json) = serde_json::to_string(&prepared_keys) {
        command.env("AETHON_WORKER_DEVSHELL_ENV_KEYS", keys_json);
    }
    if let Some(kind) = prepared.kind.as_deref() {
        command.env("AETHON_WORKER_DEVSHELL_KIND", kind);
        if kind != "direnv" {
            command.env("DIRENV_DISABLE", "1");
        }
    }
    for (k, v) in prepared.env {
        command.env(k, v);
    }
}

fn apply_worker_current_dir(command: &mut Command, worker: Option<&AgentWorker>) {
    let Some(worker) = worker else {
        return;
    };
    let Some(cwd) = worker.cwd.as_deref().filter(|cwd| !cwd.is_empty()) else {
        return;
    };
    command.current_dir(cwd);
}

fn should_respawn_for_worker_cwd(
    key: &str,
    meta: &Arc<Mutex<HashMap<String, WorkerMeta>>>,
    worker: Option<&AgentWorker>,
) -> bool {
    let Some(worker_cwd) = worker
        .and_then(|w| w.cwd.as_deref())
        .filter(|cwd| !cwd.is_empty())
    else {
        return false;
    };
    let Ok(map) = meta.lock() else {
        return false;
    };
    let Some(existing) = map.get(key) else {
        return false;
    };
    existing.cwd.as_deref() != Some(worker_cwd)
}

/// Synthesise the `{"type":"report"}` handshake that the React tree
/// would otherwise send on mount. Worker bridges are spawned in
/// response to a frontend action (e.g. `agent_command` for a tab), so
/// the webview is provably up by the time we get here — but the
/// frontend's `useBridgeMessages` boot effect routes that message to
/// the `__global__` agent only (see `process::route_payload_key`).
/// Without this injection a worker's `state.frontendReady` stays
/// `false`, `sendQuery` in `agent/devshell/client.ts` races against
/// its 5s timeout and resolves to `frontend_not_ready`, and pi's bash
/// tool inherits the host env instead of the project's Nix devshell.
///
/// Sending it for the global agent too is harmless: the React tree
/// will send its own `report` shortly after mount, and
/// `markFrontendReady` is idempotent.
pub(super) fn inject_initial_handshake<W: std::io::Write>(stdin: &mut W) -> std::io::Result<()> {
    stdin.write_all(b"{\"type\":\"report\"}\n")?;
    stdin.flush()
}

#[cfg(test)]
mod tests {
    use super::inject_initial_handshake;

    #[test]
    fn handshake_is_a_single_newline_terminated_report_line() {
        let mut buf = Vec::<u8>::new();
        inject_initial_handshake(&mut buf).unwrap();
        let s = String::from_utf8(buf).expect("ascii");
        assert_eq!(s, "{\"type\":\"report\"}\n");
        // Dispatcher reads line-by-line; exactly one newline keeps us
        // off the "two messages on one line" footgun.
        assert_eq!(s.matches('\n').count(), 1);
    }

    #[test]
    fn handshake_parses_to_the_report_message_shape() {
        let mut buf = Vec::<u8>::new();
        inject_initial_handshake(&mut buf).unwrap();
        let line = std::str::from_utf8(&buf).unwrap().trim_end();
        let v: serde_json::Value = serde_json::from_str(line).expect("valid json");
        assert_eq!(v.get("type").and_then(|t| t.as_str()), Some("report"));
    }
}
