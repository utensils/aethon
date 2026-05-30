//! Built-in HTTP + mDNS server scaffold.
//!
//! Models Claudette's daemon pattern: one `ServiceDaemon` advertises
//! `_aethon._tcp.local.`, a second `ServiceDaemon` browses for peers and
//! emits `host-discovered` / `host-removed` Tauri events. An axum HTTP
//! server binds `0.0.0.0:0` (OS picks the port → mDNS TXT) and exposes
//! `GET /health` + `GET /status`. No auth, no TLS — explicitly scaffold
//! until the pairing PR replaces fingerprint + adds tokens.
//!
//! Lifecycle: `boot(app)` unconditionally binds HTTP, registers mDNS
//! advertise, and starts the browser (a `[server] enabled` config gate
//! is planned alongside the pairing PR but not wired yet). Browser runs
//! even when advertiser is off — discovery is read-only and useful in
//! isolation. `shutdown(state)` aborts the join handles and drops both
//! `ServiceDaemon`s.

use std::sync::Arc;
use tauri::AppHandle;
use tauri::async_runtime::JoinHandle;
use tokio::sync::Mutex;

pub mod http;
pub mod mdns;

/// Holds the running server's resources so we can shut down cleanly.
/// All fields owned: dropping `ServerHandle` stops the advertisement
/// and the HTTP listener.
pub struct ServerHandle {
    pub port: u16,
    pub http_task: JoinHandle<()>,
    // Held for the lifetime of the announcement — dropping the daemon
    // stops the mDNS advertisement. `None` when advertising is gated off
    // via `[server] enabled = false` (HTTP + browser still run). Never
    // read directly.
    #[allow(dead_code)]
    pub advertise_daemon: Option<mdns_sd::ServiceDaemon>,
}

/// Managed by Tauri (`.manage(ServerState::new())`). Wraps an
/// `Arc<Mutex<Option<ServerHandle>>>` so `server_start` / `server_stop`
/// can rebuild the handle without rebuilding the registration.
#[derive(Default)]
pub struct ServerState {
    inner: Arc<Mutex<Option<ServerHandle>>>,
}

impl ServerState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    pub async fn port(&self) -> Option<u16> {
        self.inner.lock().await.as_ref().map(|h| h.port)
    }

    pub async fn set(&self, handle: ServerHandle) {
        let mut guard = self.inner.lock().await;
        if let Some(prev) = guard.take() {
            prev.http_task.abort();
            // Dropping prev.advertise_daemon stops the announcement.
        }
        *guard = Some(handle);
    }

    pub async fn stop(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(prev) = guard.take() {
            prev.http_task.abort();
        }
    }
}

/// Start the server on app boot. Failures log + carry on — a network
/// hiccup must never block the UI. The mDNS advertiser is gated on
/// `[server] enabled` (default true); the browser always runs.
pub fn boot(app: AppHandle, state: Arc<ServerState>) {
    tauri::async_runtime::spawn(async move {
        let advertise = server_advertise_enabled(&app);
        if let Err(e) = start(&app, &state, advertise).await {
            tracing::warn!(target: "aethon::server", "boot failed: {e}");
        }
        if !advertise {
            tracing::info!(target: "aethon::server", "mDNS advertiser disabled via [server] enabled = false");
        }
        if let Err(e) = mdns::start_browser(app.clone()) {
            tracing::warn!(target: "aethon::server::mdns", "browser failed: {e}");
        }
    });
}

/// Read `[server] enabled` from `~/.aethon/config.toml` (default true).
fn server_advertise_enabled(app: &AppHandle) -> bool {
    use tauri::Manager;
    let Ok(home) = app.path().home_dir() else {
        return true;
    };
    let user_dir =
        crate::helpers::aethon_dir(Some(home.clone())).unwrap_or_else(|| home.join(".aethon"));
    let raw = std::fs::read_to_string(user_dir.join("config.toml")).unwrap_or_default();
    crate::helpers::parse_config_toml(&raw)["server"]["enabled"]
        .as_bool()
        .unwrap_or(true)
}

/// Bind HTTP + (optionally) register the mDNS advertiser. Pulled out so the
/// `server_start` IPC can reuse it after a user-triggered stop — that path
/// passes `advertise = true` so an explicit start always announces,
/// regardless of the config gate.
pub async fn start(_app: &AppHandle, state: &ServerState, advertise: bool) -> Result<u16, String> {
    let info = crate::commands::host::local_host_info();
    let (port, http_task) = http::serve(info.clone()).await?;
    let advertise_daemon = if advertise {
        Some(
            mdns::advertise(&info.display_name, port, &info.fingerprint)
                .map_err(|e| format!("mdns advertise failed: {e}"))?,
        )
    } else {
        None
    };
    let handle = ServerHandle {
        port,
        http_task,
        advertise_daemon,
    };
    state.set(handle).await;
    tracing::info!(target: "aethon::server", "listening on 0.0.0.0:{port}");
    Ok(port)
}
