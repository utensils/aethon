//! Built-in HTTP + mDNS server scaffold.
//!
//! Models Claudette's daemon pattern: one `ServiceDaemon` advertises
//! `_aethon._tcp.local.`, a second `ServiceDaemon` browses for peers and
//! emits `host-discovered` / `host-removed` Tauri events. An axum HTTP
//! server binds `0.0.0.0:0` (OS picks the port → mDNS TXT) and exposes
//! `GET /health` + `GET /status`. No auth, no TLS — explicitly scaffold
//! until the pairing PR replaces fingerprint + adds tokens.
//!
//! Lifecycle: `boot(app)` binds HTTP and registers mDNS advertisement only
//! when `[server] enabled` is true (the default). The mDNS browser runs even
//! when the local server is disabled — discovery is read-only and useful in
//! isolation. `shutdown(state)` aborts the join handles and drops both
//! `ServiceDaemon`s.

use std::future::Future;
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
    // stops the mDNS advertisement. `None` when callers start the HTTP
    // listener without advertising. Never read directly.
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
/// hiccup must never block the UI. The HTTP listener and mDNS advertiser
/// are gated on `[server] enabled` (default true); the browser always runs.
pub fn boot(app: AppHandle, state: Arc<ServerState>) {
    tauri::async_runtime::spawn(async move {
        let enabled = server_enabled(&app);
        match start_on_boot_if_enabled(enabled, || start(&app, &state, true)).await {
            Ok(Some(_)) => {}
            Ok(None) => {
                tracing::info!(target: "aethon::server", "local HTTP listener and mDNS advertiser disabled via [server] enabled = false");
            }
            Err(e) => {
                tracing::warn!(target: "aethon::server", "boot failed: {e}");
            }
        }
        if let Err(e) = mdns::start_browser(app.clone()) {
            tracing::warn!(target: "aethon::server::mdns", "browser failed: {e}");
        }
    });
}

/// Read `[server] enabled` from `~/.aethon/config.toml` (default true).
fn server_enabled(app: &AppHandle) -> bool {
    use tauri::Manager;
    let Ok(home) = app.path().home_dir() else {
        return true;
    };
    let user_dir =
        crate::helpers::aethon_dir(Some(home.clone())).unwrap_or_else(|| home.join(".aethon"));
    let raw = std::fs::read_to_string(user_dir.join("config.toml")).unwrap_or_default();
    server_enabled_from_config_text(&raw)
}

fn server_enabled_from_config_text(raw: &str) -> bool {
    crate::helpers::parse_config_toml(raw)["server"]["enabled"]
        .as_bool()
        .unwrap_or(true)
}

async fn start_on_boot_if_enabled<F, Fut>(
    enabled: bool,
    start_listener: F,
) -> Result<Option<u16>, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<u16, String>>,
{
    if enabled {
        start_listener().await.map(Some)
    } else {
        Ok(None)
    }
}

/// Bind HTTP + (optionally) register the mDNS advertiser. Pulled out so the
/// `server_start` IPC can reuse it after a disabled boot or user-triggered
/// stop — that path passes `advertise = true` so an explicit start always
/// announces, regardless of the config gate.
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::{server_enabled_from_config_text, start_on_boot_if_enabled};

    #[tokio::test]
    async fn disabled_server_config_skips_boot_http_listener() {
        let called = Arc::new(AtomicBool::new(false));
        let starter_called = Arc::clone(&called);
        let enabled = server_enabled_from_config_text("[server]\nenabled = false\n");

        let result = start_on_boot_if_enabled(enabled, || async move {
            starter_called.store(true, Ordering::SeqCst);
            Ok(123)
        })
        .await;

        assert_eq!(result, Ok(None));
        assert!(!called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn enabled_server_config_runs_boot_http_listener() {
        let called = Arc::new(AtomicBool::new(false));
        let starter_called = Arc::clone(&called);
        let enabled = server_enabled_from_config_text("");

        let result = start_on_boot_if_enabled(enabled, || async move {
            starter_called.store(true, Ordering::SeqCst);
            Ok(123)
        })
        .await;

        assert_eq!(result, Ok(Some(123)));
        assert!(called.load(Ordering::SeqCst));
    }
}
