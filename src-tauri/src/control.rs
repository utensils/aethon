//! Release-safe local control service for `aethonctl`.
//!
//! This is deliberately separate from the debug eval server. The service binds
//! a user-local Unix socket, writes a per-launch token under `~/.aethon/control`,
//! and only exposes typed request methods. UI-owned mutations are forwarded to
//! the webview as `control-request` events and completed by the frontend via
//! `control_request_complete`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

const PROTOCOL_VERSION: u32 = 1;
/// Timeout for a forwarded request that carries no explicit `timeoutMs` (the
/// quick UI-owned mutations: open/close/focus/account/stop).
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// Hard ceiling for a forwarded request, even one that asks to wait. `chat.send
/// --wait` / `chat.wait` legitimately block for the whole agent turn (minutes),
/// so the frontend passes its own `timeoutMs`; we honor it up to this cap so a
/// long turn never reports a false timeout, while a wedged frontend can't pin a
/// request open forever.
const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
/// Cap on a single control request line. Requests are small (method + params);
/// a `chat.send` message is the largest field. Generous enough for a sizeable
/// `--file` prompt, bounded so a local client can't stream unbounded memory.
const MAX_REQUEST_BYTES: u64 = 16 * 1024 * 1024;

/// Resolve the await timeout for a forwarded request, honoring a caller-supplied
/// `timeoutMs` (plus a margin so the backend never beats the frontend's own
/// wait) up to [`MAX_REQUEST_TIMEOUT`].
fn request_timeout(params: &Value) -> Duration {
    match params.get("timeoutMs").and_then(Value::as_u64) {
        Some(ms) => Duration::from_millis(ms)
            .saturating_add(Duration::from_secs(60))
            .min(MAX_REQUEST_TIMEOUT),
        None => DEFAULT_REQUEST_TIMEOUT,
    }
}

/// Constant-time string compare for the per-launch token, so an authorized-vs-
/// not decision doesn't leak via timing. Length is allowed to short-circuit
/// (the token is a fixed-length uuid).
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Default)]
pub(crate) struct ControlState {
    token: Mutex<Option<String>>,
    info: Mutex<Option<ControlInfo>>,
    frontend_state: Mutex<Value>,
    pending: Mutex<HashMap<String, oneshot::Sender<ControlCompletion>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlInfo {
    protocol_version: u32,
    mode: String,
    socket_path: String,
    token_path: String,
    pid: u32,
    version: String,
    instance_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlRequest {
    token: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendControlRequest {
    request_id: String,
    method: String,
    params: Value,
}

struct ControlCompletion {
    success: bool,
    data: Option<Value>,
    error: Option<String>,
}

#[tauri::command]
pub(crate) fn control_update_state(
    snapshot: Value,
    state: State<'_, Arc<ControlState>>,
    remote: State<'_, Arc<crate::server::remote::RemoteState>>,
) -> Result<(), String> {
    // Mirror the snapshot to remote clients as the `frontend-state`
    // topic — the convergence signal that keeps every paired device's
    // view of tabs/models/accounts in step regardless of who mutated.
    if let Ok(json) = serde_json::to_string(&snapshot) {
        remote.hub.publish("frontend-state", json);
    }
    *state.frontend_state.lock().map_err(|e| e.to_string())? = snapshot;
    Ok(())
}

#[tauri::command]
pub(crate) fn control_request_complete(
    request_id: String,
    success: bool,
    data: Option<Value>,
    error: Option<String>,
    state: State<'_, Arc<ControlState>>,
) -> Result<(), String> {
    let sender = state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id);
    match sender {
        Some(sender) => {
            let _ = sender.send(ControlCompletion {
                success,
                data,
                error,
            });
        }
        None => {
            // Late or duplicate completion: the forward already timed out and
            // purged this entry (or the frontend completed twice). There's
            // nothing left to resolve — treat it as a no-op rather than failing
            // the command, which would surface as a noisy invoke error.
            tracing::debug!(
                target: "aethon::control",
                "control_request_complete: no pending request {request_id}"
            );
        }
    }
    Ok(())
}

pub(crate) fn start_control_server(app: AppHandle, state: Arc<ControlState>) {
    #[cfg(unix)]
    {
        tauri::async_runtime::spawn(async move {
            if let Err(err) = unix::run(app, state).await {
                tracing::error!(target: "aethon::control", "control server failed: {err}");
            }
        });
    }

    #[cfg(not(unix))]
    {
        let _ = (app, state);
        tracing::warn!(
            target: "aethon::control",
            "aethonctl release control is not implemented on this platform yet"
        );
    }
}

async fn handle_request(
    app: &AppHandle,
    state: &Arc<ControlState>,
    req: ControlRequest,
) -> ControlResponse {
    let expected = match state.token.lock() {
        Ok(guard) => guard.clone(),
        Err(err) => return err_response(format!("control token lock: {err}")),
    };
    if !expected.is_some_and(|token| token_eq(&token, &req.token)) {
        return err_response("unauthorized".to_string());
    }

    match req.method.as_str() {
        "control.info" => {
            let info = match state.info.lock() {
                Ok(guard) => guard.clone(),
                Err(err) => return err_response(format!("control info lock: {err}")),
            };
            ok_response(json!({ "info": info }))
        }
        "status" | "tabs.list" | "models.list" | "accounts.list" => {
            readonly_response(&req.method, state)
        }
        "tabs.open" | "tabs.close" | "tabs.focus" | "chat.send" | "chat.wait" | "accounts.use"
        | "agent.stop" => forward_to_frontend(app, state, req).await,
        "eval" | "invoke" | "agent.command" => err_response(
            "raw debug commands are not available on the release control transport".to_string(),
        ),
        other => err_response(format!("unknown control method: {other}")),
    }
}

fn readonly_response(method: &str, state: &Arc<ControlState>) -> ControlResponse {
    let snapshot = match state.frontend_state.lock() {
        Ok(guard) => guard.clone(),
        Err(err) => return err_response(format!("frontend state lock: {err}")),
    };
    match method {
        "status" => {
            let accounts = snapshot
                .get("authProfiles")
                .and_then(|a| a.get("profiles"))
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0);
            let tabs = snapshot
                .get("tabs")
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0);
            ok_response(json!({
                "location": snapshot.get("location").cloned().unwrap_or(Value::Null),
                "status": snapshot.get("status").cloned().unwrap_or(Value::Null),
                "connection": snapshot.get("connection").cloned().unwrap_or(Value::Null),
                "waiting": snapshot.get("waiting").cloned().unwrap_or(Value::Bool(false)),
                "model": snapshot.get("model").cloned().unwrap_or(Value::Null),
                "activeTabId": snapshot.get("activeTabId").cloned().unwrap_or(Value::Null),
                "tabs": tabs,
                "accounts": accounts,
                "transport": "control",
            }))
        }
        "tabs.list" => ok_response(snapshot.get("tabs").cloned().unwrap_or_else(|| json!([]))),
        "models.list" => ok_response(snapshot.get("models").cloned().unwrap_or_else(|| json!([]))),
        "accounts.list" => ok_response(
            snapshot
                .get("authProfiles")
                .cloned()
                .unwrap_or_else(|| json!({ "profiles": [] })),
        ),
        _ => err_response(format!("unknown readonly method: {method}")),
    }
}

async fn forward_to_frontend(
    app: &AppHandle,
    state: &Arc<ControlState>,
    req: ControlRequest,
) -> ControlResponse {
    match forward_ui_method(app, state, &req.method, req.params).await {
        Ok(value) => ok_response(value),
        Err(err) => err_response(err),
    }
}

/// Round one UI-owned mutation through the desktop webview: emit a
/// `control-request`, await the matching `control_request_complete`.
/// Shared by the local control socket and the remote gateway's `ui.*`
/// forwards, so both serialize on the same pending map + timeouts.
pub(crate) async fn forward_ui_method(
    app: &AppHandle,
    state: &Arc<ControlState>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let timeout = request_timeout(&params);
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|err| format!("pending lock: {err}"))?;
        pending.insert(request_id.clone(), tx);
    }
    let payload = FrontendControlRequest {
        request_id: request_id.clone(),
        method: method.to_string(),
        params,
    };
    if let Err(err) = app.emit("control-request", payload) {
        let _ = state.pending.lock().map(|mut p| p.remove(&request_id));
        return Err(format!("emit control-request: {err}"));
    }
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(done)) if done.success => Ok(done.data.unwrap_or(Value::Null)),
        Ok(Ok(done)) => Err(done
            .error
            .unwrap_or_else(|| "control request failed".to_string())),
        Ok(Err(_)) => Err("control request was cancelled".to_string()),
        Err(_) => {
            let _ = state.pending.lock().map(|mut p| p.remove(&request_id));
            Err("control request timed out".to_string())
        }
    }
}

fn ok_response(result: Value) -> ControlResponse {
    ControlResponse {
        ok: true,
        result: Some(result),
        error: None,
    }
}

fn err_response(error: String) -> ControlResponse {
    ControlResponse {
        ok: false,
        result: None,
        error: Some(error),
    }
}

fn aethon_control_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?
        .join("control");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {}: {e}", dir.display()))?;
    Ok(dir)
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};

    use crate::helpers::secure_files::{set_dir_owner_only, write_owner_only};

    pub(super) async fn run(app: AppHandle, state: Arc<ControlState>) -> Result<(), String> {
        let dir = aethon_control_dir(&app)?;
        // Lock the control dir to the owner before writing anything into it.
        // With the dir at 0o700, no other local user can even reach the token,
        // control.json, or socket regardless of the individual file modes.
        set_dir_owner_only(&dir)?;
        let socket_path = dir.join("control.sock");
        let token_path = dir.join("token");
        let info_path = dir.join("control.json");
        let _ = std::fs::remove_file(&socket_path);

        let token = uuid::Uuid::new_v4().to_string();
        write_owner_only(&token_path, token.as_bytes())?;

        let info = ControlInfo {
            protocol_version: PROTOCOL_VERSION,
            mode: "local".to_string(),
            socket_path: socket_path.to_string_lossy().into_owned(),
            token_path: token_path.to_string_lossy().into_owned(),
            pid: std::process::id(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            instance_id: uuid::Uuid::new_v4().to_string(),
        };
        write_owner_only(
            &info_path,
            serde_json::to_string_pretty(&info)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )?;

        *state.token.lock().map_err(|e| e.to_string())? = Some(token);
        *state.info.lock().map_err(|e| e.to_string())? = Some(info);

        let listener = UnixListener::bind(&socket_path)
            .map_err(|e| format!("bind {}: {e}", socket_path.display()))?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod {}: {e}", socket_path.display()))?;
        tracing::info!(
            target: "aethon::control",
            "control socket listening at {}",
            socket_path.display()
        );

        loop {
            let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let app = app.clone();
            let state = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                if let Err(err) = handle_stream(app, state, stream).await {
                    tracing::warn!(target: "aethon::control", "request failed: {err}");
                }
            });
        }
    }

    async fn handle_stream(
        app: AppHandle,
        state: Arc<ControlState>,
        stream: UnixStream,
    ) -> Result<(), String> {
        let (reader, mut writer) = stream.into_split();
        // Cap the request so a local client can't stream unbounded memory; a
        // truncated request just fails to parse below.
        let mut lines = BufReader::new(reader.take(MAX_REQUEST_BYTES)).lines();
        let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let response = match serde_json::from_str::<ControlRequest>(&line) {
            Ok(req) => handle_request(&app, &state, req).await,
            Err(err) => err_response(format!("invalid control request: {err}")),
        };
        let body = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
        writer.write_all(&body).await.map_err(|e| e.to_string())?;
        writer.write_all(b"\n").await.map_err(|e| e.to_string())?;
        writer.shutdown().await.map_err(|e| e.to_string())
    }

    // write_owner_only's permission property is covered by the shared
    // helper's tests in `helpers::secure_files`.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_timeout_honors_param_with_margin_and_cap() {
        assert_eq!(request_timeout(&json!({})), DEFAULT_REQUEST_TIMEOUT);
        assert_eq!(
            request_timeout(&json!({ "timeoutMs": 1000_u64 })),
            Duration::from_millis(1000) + Duration::from_secs(60)
        );
        assert_eq!(
            request_timeout(&json!({ "timeoutMs": u64::MAX })),
            MAX_REQUEST_TIMEOUT
        );
    }

    #[test]
    fn token_eq_matches_only_identical_tokens() {
        assert!(token_eq("a1b2c3", "a1b2c3"));
        assert!(!token_eq("a1b2c3", "a1b2c4"));
        assert!(!token_eq("a1b2c3", "a1b2c3x"));
        assert!(!token_eq("", "x"));
    }

    #[test]
    fn readonly_status_counts_tabs_and_accounts() {
        let state = Arc::new(ControlState::default());
        *state.frontend_state.lock().unwrap() = json!({
            "status": "ready",
            "connection": "connected",
            "waiting": false,
            "model": "openai-codex/gpt-5.5",
            "activeTabId": "t1",
            "tabs": [{ "id": "t1" }, { "id": "t2" }],
            "authProfiles": { "profiles": [{ "id": "p1" }] }
        });
        let response = readonly_response("status", &state);
        assert!(response.ok);
        let result = response.result.unwrap();
        assert_eq!(result["tabs"], 2);
        assert_eq!(result["accounts"], 1);
        assert_eq!(result["transport"], "control");
    }
}
