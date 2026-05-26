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

use super::process::AgentWorker;
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

    if guard.contains_key(key) {
        return Ok(());
    }

    let mut command = build_command(app)?;
    apply_user_env(app, &mut command);
    apply_worker_env(&mut command, worker.as_ref());

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
        stderr_tail: Arc::clone(&stderr_tail),
    });

    let stderr = child.stderr.take().ok_or("no stderr on spawned agent")?;
    spawn_stderr_reader(StderrReaderCtx {
        stderr,
        app: app.clone(),
        pid,
        key: key.to_string(),
        stderr_tail,
    });

    guard.insert(key.to_string(), Arc::new(Mutex::new(child)));
    Ok(())
}

fn build_command(app: &AppHandle) -> Result<Command, String> {
    if cfg!(debug_assertions) {
        let root = project_root();
        let docs_dir = root.join("docs").join("aethon-agent");
        let boot_layout_file = root
            .join("src")
            .join("skills")
            .join("default-layout")
            .join("workstation.a2ui.json");
        let layout_slots_file = root
            .join("src")
            .join("skills")
            .join("default-layout")
            .join("slots.json");
        let mut c = env::command("bun");
        c.current_dir(&root).arg("run").arg("agent/main.ts");
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
            .join("skills")
            .join("default-layout")
            .join("workstation.a2ui.json");
        let layout_slots_file = resource_dir
            .join("skills")
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
