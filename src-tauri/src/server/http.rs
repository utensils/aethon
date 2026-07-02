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
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router, routing::get};
use axum_server::tls_rustls::RustlsConfig;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;

use crate::commands::host::HostInfo;
use crate::server::remote::relay::RelayExec;
use crate::server::remote::{GatewayCtx, RemoteState, pairing, ws};
use crate::server::tls::TlsIdentity;

pub fn router(
    info: HostInfo,
    remote: Arc<RemoteState>,
    relay: Arc<dyn RelayExec>,
    device_changed: Arc<dyn Fn(&crate::server::remote::devices::DeviceView) + Send + Sync>,
) -> Router {
    let status_info = info.clone();
    let ctx = GatewayCtx {
        info,
        remote,
        relay,
        device_changed,
    };
    Router::new()
        .route("/health", get(|| async { "aethon" }))
        .route(
            "/status",
            get(move || {
                let info = status_info.clone();
                async move { Json(info) }
            }),
        )
        // /pair is armed only during an active pairing window and
        // 404s otherwise. In production the listener is always TLS
        // (remote_pairing_begin refuses without a cert identity); the
        // one path where pairing runs over plaintext is the dev-only
        // `allow_insecure_ws` mode (debug builds), where the operator
        // has explicitly opted into a trusted LAN. /ws authenticates
        // per-token on its first frame regardless.
        .route("/pair", post(pairing::pair_handler))
        .route("/ws", get(ws::ws_handler))
        .route("/asset", get(asset_handler))
        .with_state(ctx)
}

#[derive(serde::Deserialize)]
struct AssetQuery {
    path: String,
    token: String,
}

/// `GET /asset?path=…&token=…` — the mobile equivalent of Tauri's
/// `convertFileSrc` for chat image attachments. Token in the query
/// because `<img src>` can't carry headers; the URL never leaves the
/// paired transport. Routed through the relay so it reuses the exact
/// jailed read path (`read_paste_image_base64`: pastes dir only,
/// 32 MiB cap) rather than growing a second file-serving surface.
async fn asset_handler(State(ctx): State<GatewayCtx>, Query(query): Query<AssetQuery>) -> Response {
    use base64::Engine;
    if ctx.remote.devices.verify_token(&query.token).is_none() {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let args = serde_json::json!({ "path": query.path });
    let b64 = match ctx.relay.invoke("read_paste_image_base64", args).await {
        Ok(serde_json::Value::String(b64)) => b64,
        Ok(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "bad relay shape").into_response(),
        Err(e) => {
            tracing::debug!(target: "aethon::server::http", "asset denied: {e}");
            return (StatusCode::NOT_FOUND, "not found").into_response();
        }
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "decode failed").into_response();
    };
    let mime = match query.path.rsplit('.').next().map(str::to_ascii_lowercase) {
        Some(ext) if ext == "png" => "image/png",
        Some(ext) if ext == "jpg" || ext == "jpeg" => "image/jpeg",
        Some(ext) if ext == "gif" => "image/gif",
        Some(ext) if ext == "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    ([(header::CONTENT_TYPE, mime)], bytes).into_response()
}

/// Bind the listener and spawn the serving task. Returns the bound port
/// + the join handle (abort on `server_stop`).
pub async fn serve(
    info: HostInfo,
    port: u16,
    tls: Option<&TlsIdentity>,
    remote: Arc<RemoteState>,
    relay: Arc<dyn RelayExec>,
    app: AppHandle,
) -> Result<(u16, JoinHandle<()>), String> {
    let addr: SocketAddr = format!("0.0.0.0:{port}")
        .parse()
        .map_err(|e| format!("addr: {e}"))?;
    let app_for_devices = app.clone();
    let device_changed = Arc::new(move |device: &crate::server::remote::devices::DeviceView| {
        let _ = app_for_devices.emit("remote-devices-changed", device);
    });
    let app = router(info, remote, relay, device_changed);
    match tls {
        Some(identity) => {
            crate::server::tls::install_crypto_provider();
            let config = RustlsConfig::from_pem(
                identity.cert_pem.clone().into_bytes(),
                identity.key_pem.clone().into_bytes(),
            )
            .await
            .map_err(|e| format!("tls config: {e}"))?;
            let listener = std::net::TcpListener::bind(addr).map_err(|e| format!("bind: {e}"))?;
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
