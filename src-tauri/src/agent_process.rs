use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::helpers::parse_config_toml;
use crate::{env, helpers};

pub(crate) const GLOBAL_AGENT_KEY: &str = "__global__";

pub(crate) struct AgentProcesses {
    pub(crate) children: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    pub(crate) mutation_routes: Arc<Mutex<HashMap<String, String>>>,
    pub(crate) intentional_exits: Arc<Mutex<HashSet<String>>>,
}

impl AgentProcesses {
    pub(crate) fn new() -> Self {
        Self {
            children: Mutex::new(HashMap::new()),
            mutation_routes: Arc::new(Mutex::new(HashMap::new())),
            intentional_exits: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

pub(crate) struct AgentWorker {
    pub(crate) tab_id: String,
    pub(crate) cwd: Option<String>,
}

/// Find the project root (the directory containing `agent/main.ts`). Tauri
/// launches the dev binary with cwd set to `src-tauri/`, but our agent script
/// lives one level up, so a naive relative path resolves to the wrong place.
/// Walk up from cwd until we find the marker; fall back to cwd if nothing
/// matches.
pub(crate) fn project_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut dir: &Path = &cwd;
    for _ in 0..6 {
        if dir.join("agent").join("main.ts").exists() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => break,
        }
    }
    cwd
}

/// Locate the bundled `aethon-agent` sidecar binary. Tauri's externalBin
/// mechanism places sidecars next to the main executable on each platform
/// (e.g. `Aethon.app/Contents/MacOS/aethon-agent-aarch64-apple-darwin`).
/// Returns Err with a descriptive message when none of the candidate paths
/// exist; the caller falls back to `bun run` in dev or surfaces the error
/// in release.
fn find_sidecar_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or("current_exe has no parent dir")?
        .to_path_buf();
    let triple = env!("AETHON_TARGET_TRIPLE");
    // Tauri's externalBin strips the triple suffix before placing the file
    // alongside the main exe. Check the stripped variant first, then the raw
    // triple form for direct target/release runs.
    let ext = std::env::consts::EXE_SUFFIX;
    let candidates = [
        exe_dir.join(format!("aethon-agent{ext}")),
        exe_dir.join(format!("aethon-agent-{triple}{ext}")),
    ];
    for path in &candidates {
        if path.exists() {
            return Ok(path.clone());
        }
    }
    Err(format!(
        "aethon-agent sidecar not found next to {} (looked for: {})",
        exe.display(),
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    ))
}

/// Spawn the agent if no live child is held. Idempotent. Callers own the
/// mutex around this. In dev (`debug_assertions`) we run `bun run
/// agent/main.ts` from the project root. In release we run the bundled
/// `aethon-agent` sidecar and enrich its env with docs, layout, user-state,
/// and PATH information.
fn ensure_agent_spawned(
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

    let mut command = if cfg!(debug_assertions) {
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
        c
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
        c
    };

    if let Ok(home) = app.path().home_dir() {
        let user_dir =
            helpers::aethon_dir(Some(home.clone())).unwrap_or_else(|| home.join(".aethon"));
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
    if let Some(worker) = &worker {
        command.env("AETHON_WORKER_TAB_ID", &worker.tab_id);
        if let Some(cwd) = &worker.cwd
            && !cwd.is_empty()
        {
            command.env("AETHON_WORKER_CWD", cwd);
        }
    }

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn agent: {e}"))?;

    let pid = child.id();
    tracing::info!(target: "aethon::agent", key = key, "spawned pid={pid}");

    let stderr_tail: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(32)));
    const STDERR_TAIL_CAP: usize = 32;

    let stdout = child.stdout.take().ok_or("no stdout on spawned agent")?;
    let app_stdout = app.clone();
    let stderr_tail_for_supervisor = Arc::clone(&stderr_tail);
    let stdout_key = key.to_string();
    let stdout_tab_id = worker.as_ref().map(|w| w.tab_id.clone());
    let stdout_routes = Arc::clone(&mutation_routes);
    let stdout_intentional_exits = Arc::clone(&intentional_exits);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut saw_reload_done = false;
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    if text.contains("\"_reload_done\"") {
                        saw_reload_done = true;
                        let _ = app_stdout.emit("agent-reloaded", "");
                        continue;
                    }
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
                        && let Some(mutation_id) = value.get("mutationId").and_then(|v| v.as_str())
                        && let Ok(mut routes) = stdout_routes.lock()
                    {
                        routes.insert(mutation_id.to_string(), stdout_key.clone());
                    }
                    let _ = app_stdout.emit("agent-response", text);
                }
                Err(_) => break,
            }
        }
        tracing::debug!(target: "aethon::agent", key = stdout_key, "stdout reader for pid={pid} exited");
        let intentional_exit = stdout_intentional_exits
            .lock()
            .map(|mut exits| exits.remove(&stdout_key))
            .unwrap_or(false);
        if intentional_exit || saw_reload_done {
            return;
        }
        let tail: Vec<String> = match stderr_tail_for_supervisor.lock() {
            Ok(g) => g.iter().cloned().collect(),
            Err(_) => Vec::new(),
        };
        let _ = app_stdout.emit(
            "agent-crashed",
            serde_json::json!({
                "pid": pid,
                "tabId": stdout_tab_id,
                "stderrTail": tail,
            }),
        );
    });

    let stderr = child.stderr.take().ok_or("no stderr on spawned agent")?;
    let app_stderr = app.clone();
    let stderr_tail_writer = Arc::clone(&stderr_tail);
    let stderr_key = key.to_string();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    tracing::info!(target: "aethon::agent::stderr", pid = pid, key = stderr_key, "{text}");
                    if let Ok(mut g) = stderr_tail_writer.lock() {
                        if g.len() >= STDERR_TAIL_CAP {
                            g.pop_front();
                        }
                        g.push_back(text.clone());
                    }
                    let _ = app_stderr.emit("agent-stderr", text);
                }
                Err(_) => break,
            }
        }
        tracing::debug!(target: "aethon::agent", key = stderr_key, "stderr reader for pid={pid} exited");
    });

    guard.insert(key.to_string(), Arc::new(Mutex::new(child)));
    Ok(())
}

pub(crate) fn tab_agent_key(tab_id: &str) -> String {
    format!("tab:{tab_id}")
}

pub(crate) fn write_agent_payload(
    state: &State<'_, AgentProcesses>,
    app: &AppHandle,
    key: String,
    payload: serde_json::Value,
    worker: Option<AgentWorker>,
) -> Result<(), String> {
    let child = {
        let mut guard = state.children.lock().map_err(|e| e.to_string())?;
        ensure_agent_spawned(
            &mut guard,
            &key,
            app,
            Arc::clone(&state.mutation_routes),
            Arc::clone(&state.intentional_exits),
            worker,
        )?;
        guard.get(&key).cloned().ok_or("agent not running")?
    };

    let mut child = child.lock().map_err(|e| e.to_string())?;
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    use std::io::Write;
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

pub(crate) fn ensure_global_agent(
    state: &State<'_, AgentProcesses>,
    app: &AppHandle,
) -> Result<(), String> {
    let mut guard = state.children.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(
        &mut guard,
        GLOBAL_AGENT_KEY,
        app,
        Arc::clone(&state.mutation_routes),
        Arc::clone(&state.intentional_exits),
        None,
    )
}

pub(crate) fn retire_agent_key(state: &State<'_, AgentProcesses>, key: &str) -> Result<(), String> {
    let child = {
        let mut guard = state.children.lock().map_err(|e| e.to_string())?;
        guard.remove(key)
    };
    let Some(child) = child else {
        return Ok(());
    };
    if let Ok(mut exits) = state.intentional_exits.lock() {
        exits.insert(key.to_string());
    }
    let mut child = child.lock().map_err(|e| e.to_string())?;
    let pid = child.id();
    tracing::info!(target: "aethon::agent", key = key, "retiring pid={pid}");
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

pub(crate) fn route_payload_key(
    state: &State<'_, AgentProcesses>,
    payload: &serde_json::Value,
) -> String {
    if payload.get("type").and_then(|v| v.as_str()) == Some("mutation_ack")
        && let Some(mutation_id) = payload.get("mutationId").and_then(|v| v.as_str())
        && let Ok(mut routes) = state.mutation_routes.lock()
        && let Some(key) = routes.remove(mutation_id)
    {
        return key;
    }
    let tab_scoped = matches!(
        payload.get("type").and_then(|v| v.as_str()),
        Some(
            "a2ui_event"
                | "chat"
                | "local_chat_message"
                | "native_slash_command"
                | "set_model"
                | "stop"
                | "tab_close"
                | "tab_open"
        )
    );
    if tab_scoped
        && let Some(tab_id) = payload.get("tabId").and_then(|v| v.as_str())
        && !tab_id.is_empty()
        && tab_id != "default"
    {
        return tab_agent_key(tab_id);
    }
    GLOBAL_AGENT_KEY.to_string()
}

#[cfg(test)]
mod tests {
    use super::{GLOBAL_AGENT_KEY, tab_agent_key};

    #[test]
    fn global_agent_key_is_stable() {
        assert_eq!(GLOBAL_AGENT_KEY, "__global__");
    }

    #[test]
    fn tab_agent_key_keeps_tab_prefix() {
        assert_eq!(tab_agent_key("abc"), "tab:abc");
    }
}
