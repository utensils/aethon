//! HTTP server for the LAN gateway.
//!
//! Serves `GET /health` (literal `aethon`) and `GET /status` (the JSON
//! `HostInfo` doc) over TLS using the self-signed identity in
//! [`crate::server::tls`] — paired clients pin its SHA-256 fingerprint
//! instead of verifying a chain. When the identity can't be created the
//! server degrades to the original plain-HTTP scaffold so discovery
//! stays functional; the authenticated remote-gateway routes are only
//! ever mounted on the TLS listener (or the dev-only insecure listener
//! gated by `[server] allow_insecure_ws`).
//!
//! Binds `0.0.0.0:{port}` — `[server] port`, defaulting to `0` so the
//! OS picks — and the chosen port flows back into mDNS advertising.

use std::net::SocketAddr;

use axum::{Json, Router, routing::get};
use axum_server::tls_rustls::RustlsConfig;
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener;

use crate::commands::host::HostInfo;
use crate::server::tls::TlsIdentity;

fn router(info: HostInfo) -> Router {
    Router::new()
        .route("/health", get(|| async { "aethon" }))
        .route(
            "/status",
            get(move || {
                let info = info.clone();
                async move { Json(info) }
            }),
        )
}

/// Bind the listener and spawn the serving task. Returns the bound port
/// + the join handle (abort on `server_stop`).
pub async fn serve(
    info: HostInfo,
    port: u16,
    tls: Option<&TlsIdentity>,
) -> Result<(u16, JoinHandle<()>), String> {
    let addr: SocketAddr = format!("0.0.0.0:{port}")
        .parse()
        .map_err(|e| format!("addr: {e}"))?;
    let app = router(info);
    match tls {
        Some(identity) => {
            crate::server::tls::install_crypto_provider();
            let config = RustlsConfig::from_pem(
                identity.cert_pem.clone().into_bytes(),
                identity.key_pem.clone().into_bytes(),
            )
            .await
            .map_err(|e| format!("tls config: {e}"))?;
            let listener =
                std::net::TcpListener::bind(addr).map_err(|e| format!("bind: {e}"))?;
            listener
                .set_nonblocking(true)
                .map_err(|e| format!("nonblocking: {e}"))?;
            let bound = listener
                .local_addr()
                .map_err(|e| format!("local_addr: {e}"))?
                .port();
            let server = axum_server::from_tcp_rustls(listener, config);
            let task = tauri::async_runtime::spawn(async move {
                if let Err(e) = server.serve(app.into_make_service()).await {
                    tracing::warn!(target: "aethon::server::http", "tls serve ended: {e}");
                }
            });
            Ok((bound, task))
        }
        None => {
            let listener = TcpListener::bind(addr)
                .await
                .map_err(|e| format!("bind: {e}"))?;
            let bound = listener
                .local_addr()
                .map_err(|e| format!("local_addr: {e}"))?
                .port();
            let task = tauri::async_runtime::spawn(async move {
                if let Err(e) = axum::serve(listener, app).await {
                    tracing::warn!(target: "aethon::server::http", "serve ended: {e}");
                }
            });
            Ok((bound, task))
        }
    }
}
