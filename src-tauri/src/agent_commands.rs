use std::collections::{HashMap, HashSet};
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};

use crate::agent_process::{
    AgentProcesses, AgentWorker, GLOBAL_AGENT_KEY, WorkerMeta, ensure_global_agent,
    keys_to_reconcile, retire_agent_key, route_payload_key, write_agent_payload,
};

/// Grace period before a worker is eligible for orphan reconciliation, so a
/// tab the frontend just opened (but hasn't yet included in its reported live
/// set) isn't killed mid-handshake.
const RECONCILE_MIN_AGE: Duration = Duration::from_secs(10);

#[tauri::command]
pub(crate) fn start_agent(state: State<'_, AgentProcesses>, app: AppHandle) -> Result<(), String> {
    ensure_global_agent(&state, &app)
}

#[tauri::command]
pub(crate) fn send_message(
    message: String,
    tab_id: Option<String>,
    mode: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    state: State<'_, AgentProcesses>,
    app: AppHandle,
) -> Result<(), String> {
    let tab_id = tab_id.unwrap_or_else(|| "default".to_string());
    let mut payload = serde_json::json!({
        "type": "chat",
        "content": message,
        "mode": mode.unwrap_or_else(|| "normal".to_string()),
        "tabId": tab_id,
    });
    if let Some(cwd) = cwd
        && !cwd.is_empty()
    {
        payload["cwd"] = serde_json::Value::String(cwd);
    }
    if let Some(model) = model
        && !model.is_empty()
    {
        payload["model"] = serde_json::Value::String(model);
    }

    let key = route_payload_key(&state, &payload);
    let worker = worker_for_payload(&key, &payload, true);
    write_agent_payload(&state, &app, key, payload, worker)
}

/// Hard-kill the running agent child. Called by the frontend's hang-warn
/// notification "Force restart" button. We intentionally let the crash path
/// fire: the existing `agent-crashed` handler clears waiting state and (if
/// auto_restart_agent = true) respawns automatically.
#[tauri::command]
pub(crate) fn force_restart_agent(state: State<'_, AgentProcesses>) -> Result<(), String> {
    let children: Vec<_> = {
        let mut guard = state.children.lock().map_err(|e| e.to_string())?;
        guard.drain().collect()
    };
    for (key, child) in children {
        let mut child = child.lock().map_err(|e| e.to_string())?;
        let pid = child.id();
        tracing::warn!(target: "aethon::agent", key = key, "force_restart_agent: killing pid={pid}");
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Ok(mut routes) = state.mutation_routes.lock() {
        routes.clear();
    }
    // Children were drained; drop their diagnostics rows so agent_diagnostics
    // never reports a worker that no longer exists. They re-register on respawn.
    if let Ok(mut meta) = state.meta.lock() {
        meta.clear();
    }
    Ok(())
}

/// Intentional kill-and-respawn for state changes the bridge can't apply
/// hot (currently: the user toggling an extension via the sidebar).
#[tauri::command]
pub(crate) fn reload_agent(state: State<'_, AgentProcesses>, app: AppHandle) -> Result<(), String> {
    let children: Vec<_> = {
        let mut guard = state.children.lock().map_err(|e| e.to_string())?;
        guard.drain().collect()
    };
    if !children.is_empty() {
        if let Ok(mut exits) = state.intentional_exits.lock() {
            for (key, _) in &children {
                exits.insert(key.clone());
            }
        }
        for (key, child) in children {
            let mut child = child.lock().map_err(|e| e.to_string())?;
            let pid = child.id();
            tracing::info!(target: "aethon::agent", key = key, "reload_agent: killing pid={pid}");
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(mut routes) = state.mutation_routes.lock() {
            routes.clear();
        }
        // Match the drained children: clear stale diagnostics rows so
        // agent_diagnostics stays "one row per live worker".
        if let Ok(mut meta) = state.meta.lock() {
            meta.clear();
        }
    }
    let _ = app.emit("agent-reloaded", "extension-toggle");
    Ok(())
}

/// Forward an arbitrary JSON payload to the agent's stdin. Used by the model
/// picker and runtime controls that are not wrapped in `dispatch_a2ui_event`.
#[tauri::command]
pub(crate) fn agent_command(
    payload: String,
    state: State<'_, AgentProcesses>,
    app: AppHandle,
) -> Result<(), String> {
    let payload_value: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("invalid agent command: {e}"))?;
    let key = route_payload_key(&state, &payload_value);
    let worker = worker_for_payload(&key, &payload_value, true);
    let should_retire = payload_value.get("type").and_then(|v| v.as_str()) == Some("tab_close")
        && key != GLOBAL_AGENT_KEY;
    write_agent_payload(&state, &app, key.clone(), payload_value, worker)?;
    if should_retire {
        retire_agent_key(&state, &key)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn dispatch_a2ui_event(
    event: String,
    tab_id: Option<String>,
    state: State<'_, AgentProcesses>,
    app: AppHandle,
) -> Result<(), String> {
    let event_value: serde_json::Value = serde_json::from_str(&event).map_err(|e| e.to_string())?;
    let tab_id = tab_id.unwrap_or_else(|| "default".to_string());
    let payload = serde_json::json!({
        "type": "a2ui_event",
        "event": event_value,
        "tabId": tab_id,
    });
    let key = route_payload_key(&state, &payload);
    let worker = worker_for_payload(&key, &payload, false);
    write_agent_payload(&state, &app, key, payload, worker)
}

/// Read-only per-worker diagnostic row. Maps a live `aethon-agent` PID back to
/// its key / tab / cwd plus idle + prompt state, so a release build (no debug
/// webview hooks) can answer "which agent is hot and why" (#159 acceptance
/// criterion). All timing is relative ("ms ago") from monotonic clocks.
#[derive(serde::Serialize)]
pub(crate) struct AgentDiagnostic {
    pub(crate) key: String,
    pub(crate) tab_id: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) pid: u32,
    pub(crate) alive: bool,
    pub(crate) spawned_ms_ago: u128,
    pub(crate) last_activity_ms_ago: u128,
    pub(crate) prompt_in_flight: bool,
    pub(crate) session_label: String,
}

/// Human-friendly label for a worker: "global" for the shared agent, otherwise
/// the cwd basename (project/worktree name) falling back to the tab id.
fn session_label_for(key: &str, meta: &WorkerMeta) -> String {
    if key == GLOBAL_AGENT_KEY {
        return "global".to_string();
    }
    if let Some(cwd) = meta.cwd.as_deref()
        && let Some(name) = cwd.rsplit(['/', '\\']).find(|s| !s.is_empty())
    {
        return name.to_string();
    }
    meta.tab_id
        .clone()
        .unwrap_or_else(|| key.trim_start_matches("tab:").to_string())
}

#[tauri::command]
pub(crate) fn agent_diagnostics(
    state: State<'_, AgentProcesses>,
) -> Result<Vec<AgentDiagnostic>, String> {
    // Snapshot child handles, then release the `children` lock before probing
    // liveness so we never hold it across a per-child `try_wait`.
    let children: Vec<(String, Arc<Mutex<Child>>)> = {
        let guard = state.children.lock().map_err(|e| e.to_string())?;
        guard
            .iter()
            .map(|(k, c)| (k.clone(), Arc::clone(c)))
            .collect()
    };
    let alive: HashMap<String, bool> = children
        .into_iter()
        .map(|(k, child)| {
            let running = child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok())
                .map(|exit| exit.is_none())
                .unwrap_or(false);
            (k, running)
        })
        .collect();

    let now = Instant::now();
    let map = state.meta.lock().map_err(|e| e.to_string())?;
    let mut rows: Vec<AgentDiagnostic> = map
        .iter()
        .map(|(key, m)| AgentDiagnostic {
            key: key.clone(),
            tab_id: m.tab_id.clone(),
            cwd: m.cwd.clone(),
            pid: m.pid,
            alive: alive.get(key).copied().unwrap_or(false),
            spawned_ms_ago: now.duration_since(m.spawned_at).as_millis(),
            last_activity_ms_ago: now.duration_since(m.last_activity).as_millis(),
            prompt_in_flight: m.prompt_in_flight,
            session_label: session_label_for(key, m),
        })
        .collect();
    rows.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(rows)
}

/// Retire per-tab workers whose tab no longer exists in the frontend's live
/// set — a safety net for a dropped `tab_close` or a worker left over from a
/// previous crash that session-restore didn't re-adopt. The frontend owns the
/// authoritative tab list and calls this on a low cadence + after restore.
/// Returns the keys retired (for observability/tests). The global agent and
/// just-spawned workers (younger than [`RECONCILE_MIN_AGE`]) are never touched.
#[tauri::command]
pub(crate) fn reconcile_agent_workers(
    live_tab_ids: Vec<String>,
    state: State<'_, AgentProcesses>,
) -> Result<Vec<String>, String> {
    let live: HashSet<String> = live_tab_ids.into_iter().collect();
    let keys = keys_to_reconcile(&state.meta, &live, Instant::now(), RECONCILE_MIN_AGE);
    for key in &keys {
        tracing::info!(target: "aethon::agent", key = key.as_str(), "reconcile-retiring orphaned worker");
        retire_agent_key(&state, key)?;
    }
    Ok(keys)
}

fn worker_for_payload(
    key: &str,
    payload: &serde_json::Value,
    include_cwd: bool,
) -> Option<AgentWorker> {
    if key == GLOBAL_AGENT_KEY {
        return None;
    }
    let tab_id = payload.get("tabId").and_then(|v| v.as_str())?;
    Some(AgentWorker {
        tab_id: tab_id.to_string(),
        cwd: include_cwd
            .then(|| {
                payload
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .flatten(),
    })
}

#[cfg(test)]
mod tests {
    use super::{GLOBAL_AGENT_KEY, WorkerMeta, session_label_for, worker_for_payload};
    use std::time::Instant;

    fn meta(tab_id: Option<&str>, cwd: Option<&str>) -> WorkerMeta {
        let now = Instant::now();
        WorkerMeta {
            tab_id: tab_id.map(str::to_string),
            cwd: cwd.map(str::to_string),
            pid: 1,
            spawned_at: now,
            last_activity: now,
            prompt_in_flight: false,
        }
    }

    #[test]
    fn session_label_uses_global_cwd_basename_then_tab() {
        assert_eq!(
            session_label_for(GLOBAL_AGENT_KEY, &meta(None, None)),
            "global"
        );
        assert_eq!(
            session_label_for(
                "tab:abc",
                &meta(Some("abc"), Some("/Users/x/Projects/aethon/"))
            ),
            "aethon",
        );
        assert_eq!(
            session_label_for("tab:abc", &meta(Some("abc"), None)),
            "abc"
        );
    }

    #[test]
    fn session_label_falls_back_to_key_without_tab() {
        assert_eq!(session_label_for("tab:xyz", &meta(None, None)), "xyz");
    }

    #[test]
    fn worker_context_carries_tab_and_optional_cwd() {
        let payload = serde_json::json!({
            "type": "chat",
            "tabId": "tab-1",
            "cwd": "/tmp/project",
        });

        let worker = worker_for_payload("tab:tab-1", &payload, true).expect("worker");

        assert_eq!(worker.tab_id, "tab-1");
        assert_eq!(worker.cwd.as_deref(), Some("/tmp/project"));
    }

    #[test]
    fn event_worker_does_not_inherit_cwd() {
        let payload = serde_json::json!({
            "type": "a2ui_event",
            "tabId": "tab-1",
            "cwd": "/tmp/project",
        });

        let worker = worker_for_payload("tab:tab-1", &payload, false).expect("worker");

        assert_eq!(worker.tab_id, "tab-1");
        assert_eq!(worker.cwd, None);
    }
}
