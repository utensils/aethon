//! Process registry + the public surface the rest of the crate uses to
//! talk to agent children.
//!
//! State held here:
//! - `children` — the per-key live `Child` handles.
//! - `mutation_routes` — the producer/consumer routing map for
//!   `mutation_ack` round-trips. Producer side lives in
//!   [`super::readers::spawn_stdout_reader`]; consumer side is
//!   [`route_payload_key`] below.
//! - `intentional_exits` — keys whose next stdout-close is *expected*
//!   (retirement or hot reload) and therefore must NOT raise
//!   `agent-crashed`. Producer is [`retire_agent_key`]; consumer is the
//!   stdout reader on EOF.

use std::collections::{HashMap, HashSet};
use std::process::Child;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, State};

use super::spawn::ensure_agent_spawned;

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
