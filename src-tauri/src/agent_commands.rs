use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent_process::{
    AgentProcesses, AgentWorker, GLOBAL_AGENT_KEY, WorkerMeta, ensure_global_agent,
    keys_to_reconcile, retire_agent_key, route_payload_key, write_agent_payload,
};
use crate::devshell::DevshellCache;

/// Grace period before a worker is eligible for orphan reconciliation, so a
/// tab the frontend just opened (but hasn't yet included in its reported live
/// set) isn't killed mid-handshake.
const RECONCILE_MIN_AGE: Duration = Duration::from_secs(10);
const MAX_ATTACHMENT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatAttachmentInput {
    id: String,
    kind: String,
    path: String,
    name: String,
    mime_type: String,
    size_bytes: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendMessageRequest {
    message: String,
    tab_id: Option<String>,
    mode: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    thinking_level: Option<String>,
    attachments: Option<Vec<ChatAttachmentInput>>,
    /// Per-tab hard project-root guardrail override. Forwarded to the agent's
    /// `chat` message so the source guard sees the current value before the
    /// turn's tool calls. `None` leaves the per-tab value untouched (the
    /// agent falls back to the global default).
    hard_enforce: Option<bool>,
    /// Per-tab plan-mode toggle. Forwarded to the agent so mutating tools can
    /// be blocked while the user is asking for analysis/design only.
    plan_mode: Option<bool>,
    /// Per-tab auth profile selected in the UI/CLI. Forwarded so a respawned
    /// worker adopts the tab's configured account before constructing its
    /// model registry.
    auth_profile_id: Option<String>,
    /// Opaque release-control request id. The bridge echoes it on lifecycle
    /// events so external callers can wait for the specific turn they sent.
    control_request_id: Option<String>,
    /// Frontend already mirrored the visible user bubble through
    /// local_chat_message; forwarded so the bridge doesn't emit a duplicate
    /// session message event for extension subscribers.
    suppress_user_session_event: Option<bool>,
}

#[tauri::command]
pub(crate) fn start_agent(state: State<'_, AgentProcesses>, app: AppHandle) -> Result<(), String> {
    ensure_global_agent(&state, &app)
}

#[tauri::command]
pub(crate) async fn send_message(
    request: SendMessageRequest,
    state: State<'_, AgentProcesses>,
    devshell: State<'_, Arc<DevshellCache>>,
    startup: State<'_, crate::commands::startup::WorkspaceStartupState>,
    app: AppHandle,
) -> Result<(), String> {
    let tab_id = request.tab_id.unwrap_or_else(|| "default".to_string());
    let mut payload = serde_json::json!({
        "type": "chat",
        "content": request.message,
        "mode": request.mode.unwrap_or_else(|| "normal".to_string()),
        "tabId": tab_id,
    });
    if let Some(cwd) = request.cwd
        && !cwd.is_empty()
    {
        payload["cwd"] = serde_json::Value::String(cwd);
    }
    if let Some(model) = request.model
        && !model.is_empty()
    {
        payload["model"] = serde_json::Value::String(model);
    }
    if let Some(thinking_level) = request.thinking_level
        && !thinking_level.is_empty()
    {
        payload["thinkingLevel"] = serde_json::Value::String(thinking_level);
    }
    if let Some(hard_enforce) = request.hard_enforce {
        payload["hardEnforce"] = serde_json::Value::Bool(hard_enforce);
    }
    if let Some(plan_mode) = request.plan_mode {
        payload["planMode"] = serde_json::Value::Bool(plan_mode);
    }
    if let Some(auth_profile_id) = request.auth_profile_id
        && !auth_profile_id.is_empty()
    {
        payload["authProfileId"] = serde_json::Value::String(auth_profile_id);
    }
    if let Some(control_request_id) = request.control_request_id
        && !control_request_id.is_empty()
    {
        payload["controlRequestId"] = serde_json::Value::String(control_request_id);
    }
    if let Some(suppress) = request.suppress_user_session_event {
        payload["suppressUserSessionEvent"] = serde_json::Value::Bool(suppress);
    }
    let images = attachments_to_agent_images(&app, request.attachments.unwrap_or_default())?;
    if !images.is_empty() {
        payload["images"] = serde_json::Value::Array(images);
    }

    dispatch_agent_payload_value(payload, state, devshell, startup, app).await
}

fn attachments_to_agent_images(
    app: &AppHandle,
    attachments: Vec<ChatAttachmentInput>,
) -> Result<Vec<serde_json::Value>, String> {
    let paste_dir = paste_dir(app)?;
    let mut images = Vec::new();
    for attachment in attachments {
        if attachment.kind != "image" {
            continue;
        }
        if !attachment.mime_type.starts_with("image/") {
            return Err(format!("attachment '{}' is not an image", attachment.name));
        }
        if attachment.size_bytes > MAX_ATTACHMENT_BYTES {
            return Err(format!("attachment '{}' exceeds 32 MiB", attachment.name));
        }
        let path = PathBuf::from(&attachment.path);
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("attachment '{}': {e}", attachment.name))?;
        if !canonical.starts_with(&paste_dir) {
            return Err(format!(
                "attachment '{}' is outside the paste directory",
                attachment.name
            ));
        }
        let metadata = std::fs::metadata(&canonical)
            .map_err(|e| format!("attachment '{}': {e}", attachment.name))?;
        if metadata.len() > MAX_ATTACHMENT_BYTES {
            return Err(format!("attachment '{}' exceeds 32 MiB", attachment.name));
        }
        let bytes = std::fs::read(&canonical)
            .map_err(|e| format!("attachment '{}': {e}", attachment.name))?;
        images.push(serde_json::json!({
            "id": attachment.id,
            "name": attachment.name,
            "mimeType": attachment.mime_type,
            "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        }));
    }
    Ok(images)
}

fn paste_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?
        .join("pastes");
    canonicalize_existing_or_parent(&dir)
}

fn canonicalize_existing_or_parent(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return path.canonicalize().map_err(|e| e.to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "paste directory has no parent".to_string())?;
    let parent = parent.canonicalize().map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "paste directory has no name".to_string())?;
    Ok(parent.join(name))
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
        let kill_started = std::time::Instant::now();
        let child_count = children.len();
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
        tracing::info!(
            target: "aethon::boot",
            children = child_count,
            elapsed_ms = kill_started.elapsed().as_millis() as u64,
            "reload_agent kill+wait complete"
        );
    }
    let _ = app.emit("agent-reloaded", "extension-toggle");
    Ok(())
}

/// Forward an arbitrary JSON payload to the agent's stdin. Used by the model
/// picker and runtime controls that are not wrapped in `dispatch_a2ui_event`.
#[tauri::command]
pub(crate) async fn agent_command(
    payload: String,
    state: State<'_, AgentProcesses>,
    devshell: State<'_, Arc<DevshellCache>>,
    startup: State<'_, crate::commands::startup::WorkspaceStartupState>,
    app: AppHandle,
) -> Result<(), String> {
    let payload_value: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("invalid agent command: {e}"))?;
    let key = route_payload_key(&state, &payload_value);
    let worker = worker_for_payload(&key, &payload_value, true);
    let should_retire = payload_value.get("type").and_then(|v| v.as_str()) == Some("tab_close")
        && key != GLOBAL_AGENT_KEY;
    prepare_worker_startup(&app, &startup, &devshell, worker.as_ref()).await?;
    write_agent_payload(&state, &app, key.clone(), payload_value, worker).await?;
    if should_retire {
        retire_agent_key(&state, &key)?;
    }
    Ok(())
}

pub(crate) async fn dispatch_agent_payload_value(
    payload_value: serde_json::Value,
    state: State<'_, AgentProcesses>,
    devshell: State<'_, Arc<DevshellCache>>,
    startup: State<'_, crate::commands::startup::WorkspaceStartupState>,
    app: AppHandle,
) -> Result<(), String> {
    let key = route_payload_key(&state, &payload_value);
    let worker = worker_for_payload(&key, &payload_value, true);
    prepare_worker_startup(&app, &startup, &devshell, worker.as_ref()).await?;
    write_agent_payload(&state, &app, key, payload_value, worker).await
}

async fn prepare_worker_startup(
    app: &AppHandle,
    startup: &crate::commands::startup::WorkspaceStartupState,
    devshell: &Arc<DevshellCache>,
    worker: Option<&AgentWorker>,
) -> Result<(), String> {
    let Some(cwd) = worker
        .and_then(|w| w.cwd.as_deref())
        .filter(|cwd| !cwd.is_empty())
    else {
        return Ok(());
    };
    crate::commands::startup::ensure_workspace_startup_ready(app, startup, devshell, cwd).await
}

/// Forward a JSON payload to every currently running agent worker without
/// spawning any new workers. Used for hot runtime config updates that must
/// reach existing tab-scoped bridge processes as well as the global worker.
#[tauri::command]
pub(crate) fn agent_broadcast_command(
    payload: String,
    state: State<'_, AgentProcesses>,
) -> Result<(), String> {
    let payload_value: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("invalid agent command: {e}"))?;
    let line = payload_value.to_string();
    let children: Vec<_> = {
        let guard = state.children.lock().map_err(|e| e.to_string())?;
        guard
            .iter()
            .map(|(k, c)| (k.clone(), Arc::clone(c)))
            .collect()
    };
    let mut failures = Vec::new();
    for (key, child) in children {
        let result = (|| -> Result<(), String> {
            let mut child = child.lock().map_err(|e| e.to_string())?;
            let stdin = child
                .stdin
                .as_mut()
                .ok_or_else(|| format!("agent {key} has no stdin"))?;
            writeln!(stdin, "{line}").map_err(|e| format!("write failed for {key}: {e}"))?;
            stdin
                .flush()
                .map_err(|e| format!("flush failed for {key}: {e}"))
        })();
        if let Err(err) = result {
            tracing::warn!(target: "aethon::agent", key = key, error = %err, "agent broadcast write failed");
            failures.push(err);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "agent broadcast failed for {} worker(s): {}",
            failures.len(),
            failures.join("; ")
        ))
    }
}

#[tauri::command]
pub(crate) async fn dispatch_a2ui_event(
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
    write_agent_payload(&state, &app, key, payload, worker).await
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
    pub(crate) bridge_ready: bool,
    pub(crate) session_label: String,
    pub(crate) process: Option<ProcessDiagnostic>,
    pub(crate) children: Vec<ProcessDiagnostic>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessDiagnostic {
    pub(crate) pid: u32,
    pub(crate) ppid: Option<u32>,
    pub(crate) cpu_percent: Option<f64>,
    pub(crate) rss_bytes: Option<u64>,
    pub(crate) command: Option<String>,
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
    let metrics = process_metrics_snapshot();
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
            bridge_ready: m.bridge_ready,
            session_label: session_label_for(key, m),
            process: metrics.get(&m.pid).cloned(),
            children: metrics
                .values()
                .filter(|p| p.ppid == Some(m.pid))
                .cloned()
                .collect(),
        })
        .collect();
    rows.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(rows)
}

fn process_metrics_snapshot() -> HashMap<u32, ProcessDiagnostic> {
    let mut command = crate::env::command("ps");
    command.args(["-axo", "pid=,ppid=,%cpu=,rss=,command="]);
    let Ok(output) = command.output() else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .filter_map(parse_ps_metrics_line)
        .map(|row| (row.pid, row))
        .collect()
}

fn parse_ps_metrics_line(line: &str) -> Option<ProcessDiagnostic> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?.parse::<u32>().ok()?;
    let ppid = parts.next().and_then(|value| value.parse::<u32>().ok());
    let cpu_percent = parts.next().and_then(|value| value.parse::<f64>().ok());
    let rss_bytes = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .map(|kib| kib.saturating_mul(1024));
    let command = parts.collect::<Vec<_>>().join(" ");
    Some(ProcessDiagnostic {
        pid,
        ppid,
        cpu_percent,
        rss_bytes,
        command: (!command.is_empty()).then_some(command),
    })
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
    use super::{
        GLOBAL_AGENT_KEY, WorkerMeta, parse_ps_metrics_line, session_label_for, worker_for_payload,
    };
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
            prompt_started_at: None,
            bridge_ready: true,
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

    #[test]
    fn parses_ps_metrics_line() {
        let row =
            parse_ps_metrics_line("  123   45  12.5  2048 /bin/bash -lc menu").expect("parsed");
        assert_eq!(row.pid, 123);
        assert_eq!(row.ppid, Some(45));
        assert_eq!(row.cpu_percent, Some(12.5));
        assert_eq!(row.rss_bytes, Some(2048 * 1024));
        assert_eq!(row.command.as_deref(), Some("/bin/bash -lc menu"));
    }
}
