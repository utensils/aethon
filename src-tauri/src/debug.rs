//! Debug-only commands and TCP eval server. Gated behind `#[cfg(debug_assertions)]`
//! — never compiled into release builds.
//!
//! Architecture:
//!   Terminal ──TCP:<port>──▶ debug server ──eval()──▶ webview JS context
//!                                                          │
//!   Terminal ◀──TCP──────── debug server ◀──invoke── webview (result callback)
//!
//! The port defaults to 19433 but can be overridden via `$AETHON_DEBUG_PORT` so
//! multiple dev instances can run side-by-side without colliding (and to avoid
//! Claudette's 19432).
//!
//! Additional commands here that the aethon-debug skill uses for UAT
//! and end-to-end inspection are scoped to dev builds only — they
//! deliberately bypass policy guards (e.g. shell share-mode gating)
//! that are important in production but make headless verification
//! impossible.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::shell::ShellRegistry;

/// Default port. Only binds to 127.0.0.1.
const DEFAULT_DEBUG_PORT: u16 = 19433;

fn debug_port() -> u16 {
    std::env::var("AETHON_DEBUG_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_DEBUG_PORT)
}

/// Tauri command: eval JS in the webview and return the result. Called by the
/// TCP server, also reachable from the webview console for ad-hoc use.
#[tauri::command]
pub async fn debug_eval_js(app: AppHandle, js: String) -> Result<String, String> {
    eval_in_webview(&app, &js).await
}

/// Wraps user JS to capture its return value, evals it in the main webview,
/// awaits the result event, returns the stringified result.
async fn eval_in_webview(app: &AppHandle, js: &str) -> Result<String, String> {
    let webview = app
        .get_webview_window("main")
        .ok_or("No main webview window found")?;

    let request_id = uuid::Uuid::new_v4().to_string();

    // Wrap user JS so it:
    //  1. Evaluates the code in an async IIFE
    //  2. Stringifies the result
    //  3. Calls back via window.__AETHON_INVOKE__ (set by main.tsx in dev)
    let wrapped = format!(
        r#"(async () => {{
  const __invoke = window.__AETHON_INVOKE__;
  if (!__invoke) {{ console.error('[debug] __AETHON_INVOKE__ not set'); return; }}
  try {{
    const __r = await (async () => {{ {js} }})();
    const __s = (typeof __r === 'string') ? __r : JSON.stringify(__r, null, 2);
    await __invoke('debug_eval_result', {{ requestId: '{request_id}', data: __s ?? 'undefined' }});
  }} catch (__e) {{
    await __invoke('debug_eval_result', {{ requestId: '{request_id}', data: 'ERROR: ' + (__e.message || String(__e)) }});
  }}
}})()"#
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Arc::new(Mutex::new(Some(tx)));

    let rid = request_id.clone();
    let tx_clone = Arc::clone(&tx);
    let listener_id = app.listen(format!("debug-eval-result-{rid}"), move |event| {
        let payload = event.payload().to_string();
        if let Some(tx) = tx_clone.lock().unwrap().take() {
            let _ = tx.send(payload);
        }
    });

    webview
        .eval(&wrapped)
        .map_err(|e| format!("eval failed: {e}"))?;

    let result = match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(result)) => {
            // Result arrives as a JSON string (quoted). Strip outer quotes if present.
            let trimmed = result.trim();
            if trimmed.starts_with('"') && trimmed.ends_with('"') {
                serde_json::from_str::<String>(trimmed).unwrap_or(result)
            } else {
                result
            }
        }
        Ok(Err(_)) => "ERROR: result channel closed".to_string(),
        Err(_) => "ERROR: timeout (10s) waiting for eval result".to_string(),
    };

    app.unlisten(listener_id);
    Ok(result)
}

/// Receives eval results from the webview. The wrapped JS calls this command
/// to send the result back; we re-emit a targeted event that `eval_in_webview`
/// is listening for.
#[tauri::command]
pub async fn debug_eval_result(
    app: AppHandle,
    request_id: String,
    data: String,
) -> Result<(), String> {
    app.emit(&format!("debug-eval-result-{request_id}"), &data)
        .map_err(|e| format!("Failed to emit result: {e}"))?;
    Ok(())
}

/// Debug-only shell inspector. Returns the slot's command + cwd +
/// share-mode + recent scrollback bytes regardless of share-mode.
/// Lets the aethon-debug skill verify a PTY actually inherited the
/// devshell env without forcing every UAT shell to be opened in
/// `read-write-trusted` mode (which would interfere with the
/// production share-mode policy tests).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugShellSnapshot {
    pub tab_id: String,
    pub cwd: String,
    pub command: String,
    pub share_mode: String,
    pub total_appended: u64,
    pub tail_bytes: usize,
    pub tail: String,
}

#[tauri::command]
pub fn debug_shell_snapshot(
    state: State<'_, ShellRegistry>,
    tab_id: String,
    tail_bytes: Option<usize>,
) -> Result<DebugShellSnapshot, String> {
    let guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
    let slot = guard
        .get(&tab_id)
        .ok_or_else(|| format!("no shell for tab {tab_id}"))?;

    let share_mode = {
        let s = slot
            .share_handle()
            .lock()
            .map_err(|e| format!("share lock: {e}"))?;
        format!("{:?}", s.mode)
    };

    let (total_appended, tail) = {
        let mut scrollback = slot
            .scrollback_handle()
            .lock()
            .map_err(|e| format!("scrollback lock: {e}"))?;
        let total = scrollback.total_appended();
        let cap = tail_bytes.unwrap_or(4096).min(64 * 1024);
        let since = total.saturating_sub(cap as u64);
        // `read_from` returns the bytes (and advances no cursor —
        // it's a pure read by total-since). Bypasses the share-mode
        // privacy floor (intentional for UAT).
        let (bytes, _new_total) = scrollback.read_from(since, cap);
        (total, String::from_utf8_lossy(&bytes).into_owned())
    };

    Ok(DebugShellSnapshot {
        tab_id: tab_id.clone(),
        cwd: slot.cwd().to_string(),
        command: slot.command().to_string(),
        share_mode,
        total_appended,
        tail_bytes: tail.len(),
        tail,
    })
}

/// Debug-only shell-input that bypasses share-mode gating. Mirrors
/// `super::shell::shell_input` but writes regardless of the slot's
/// `ShareMode`. Production `shell_write` is the share-mode-gated path
/// for the agent; this one is for the UAT skill exclusively.
#[tauri::command]
pub fn debug_shell_write_raw(
    state: State<'_, ShellRegistry>,
    tab_id: String,
    data: String,
) -> Result<(), String> {
    let mut guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
    let slot = guard
        .get_mut(&tab_id)
        .ok_or_else(|| format!("no shell for tab {tab_id}"))?;
    let writer = slot.writer_mut();
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    writer.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// Start the debug TCP eval server on 127.0.0.1. Call from the Tauri
/// `setup()` hook in debug builds only.
pub fn start_debug_server(app: AppHandle) {
    let port = debug_port();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => {
                tracing::info!(target: "aethon::debug", "Eval server listening on 127.0.0.1:{port}");
                l
            }
            Err(e) => {
                tracing::error!(target: "aethon::debug", "Failed to start eval server on port {port}: {e}");
                return;
            }
        };

        loop {
            let (mut stream, _addr) = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    tracing::warn!(target: "aethon::debug", "Accept failed: {e}");
                    continue;
                }
            };

            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                // Line-based protocol:
                //   - Read all input until EOF (client closes write half)
                //   - Eval the JS in the webview
                //   - Write result back, close
                let mut buf = Vec::with_capacity(4096);
                // Cap input at 1 MB to prevent runaway allocations.
                if let Err(e) = (&mut stream).take(1024 * 1024).read_to_end(&mut buf).await {
                    tracing::debug!(target: "aethon::debug", "Read failed: {e}");
                    return;
                }

                let js = String::from_utf8_lossy(&buf);
                let js = js.trim();
                if js.is_empty() {
                    let _ = stream.write_all(b"ERROR: empty input\n").await;
                    return;
                }

                match eval_in_webview(&app, js).await {
                    Ok(result) => {
                        let _ = stream.write_all(result.as_bytes()).await;
                        let _ = stream.write_all(b"\n").await;
                    }
                    Err(e) => {
                        let _ = stream.write_all(format!("ERROR: {e}\n").as_bytes()).await;
                    }
                }
            });
        }
    });
}
