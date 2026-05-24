//! Minimal axum HTTP server.
//!
//! Two endpoints today: `GET /health` returns the literal string
//! `aethon` (200 OK), `GET /status` returns the JSON `HostInfo` doc.
//! Binds `0.0.0.0:0` so the OS picks the port; the chosen port flows
//! back into mDNS advertising. **No auth, no TLS** — the pairing PR
//! adds both.

use std::net::SocketAddr;

use axum::{Json, Router, routing::get};
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener;

use crate::commands::host::HostInfo;

/// Bind the listener and spawn the axum task. Returns the bound port
/// + the join handle (abort on `server_stop`).
pub async fn serve(info: HostInfo) -> Result<(u16, JoinHandle<()>), String> {
    let addr: SocketAddr = "0.0.0.0:0".parse().map_err(|e| format!("addr: {e}"))?;
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    let app = Router::new()
        .route("/health", get(|| async { "aethon" }))
        .route(
            "/status",
            get(move || {
                let info = info.clone();
                async move { Json(info) }
            }),
        );
    let task = tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::warn!(target: "aethon::server::http", "serve ended: {e}");
        }
    });
    Ok((port, task))
}
