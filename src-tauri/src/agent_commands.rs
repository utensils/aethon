use tauri::{AppHandle, Emitter, State};

use crate::agent_process::{
    AgentProcesses, AgentWorker, GLOBAL_AGENT_KEY, ensure_global_agent, retire_agent_key,
    route_payload_key, write_agent_payload,
};

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
    use super::worker_for_payload;

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
