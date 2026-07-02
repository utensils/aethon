//! Built-in HTTP + mDNS server, growing into the remote gateway.
//!
//! Models Claudette's daemon pattern: one `ServiceDaemon` advertises
//! `_aethon._tcp.local.`, a second `ServiceDaemon` browses for peers and
//! emits `host-discovered` / `host-removed` Tauri events. An axum server
//! binds `0.0.0.0` (`[server] port`, default OS-assigned → mDNS TXT) and
//! exposes `GET /health` + `GET /status`, over TLS when the [`tls`]
//! identity is available. The [`remote`] module adds pairing + an
//! authenticated WebSocket relay for companion clients (iOS app).
//!
//! Lifecycle: `boot(app)` binds HTTP and registers mDNS advertisement only
//! when `[server] enabled` is true (the default). The mDNS browser runs even
//! when the local server is disabled — discovery is read-only and useful in
//! isolation. `ServerState::stop` (via `server_stop`) aborts the HTTP task
//! and drops the advertisement daemon.

use std::future::Future;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::async_runtime::JoinHandle;
use tokio::sync::Mutex;

pub mod http;
pub mod mdns;
pub mod remote;
pub mod tls;

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
        // Tap Tauri events for the remote hub exactly once per process —
        // taps survive server stop/start, so this must not live in
        // `start()` (a restart would double-publish every event).
        {
            use tauri::Manager;
            let remote = Arc::clone(app.state::<Arc<remote::RemoteState>>().inner());
            remote::events::install_taps(&remote.hub, &app);
        }
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

/// Read the raw `~/.aethon/config.toml` text ("" when unreadable).
fn server_config_raw(app: &AppHandle) -> String {
    use tauri::Manager;
    let Ok(home) = app.path().home_dir() else {
        return String::new();
    };
    let user_dir =
        crate::helpers::aethon_dir(Some(home.clone())).unwrap_or_else(|| home.join(".aethon"));
    std::fs::read_to_string(user_dir.join("config.toml")).unwrap_or_default()
}

/// Read `[server] enabled` from `~/.aethon/config.toml` (default true).
fn server_enabled(app: &AppHandle) -> bool {
    server_enabled_from_config_text(&server_config_raw(app))
}

fn server_enabled_from_config_text(raw: &str) -> bool {
    crate::helpers::parse_config_toml(raw)["server"]["enabled"]
        .as_bool()
        .unwrap_or(true)
}

/// Read `[server] port` (default 0 → OS-assigned). Out-of-range values
/// fall back to 0 rather than failing boot.
fn server_port_from_config_text(raw: &str) -> u16 {
    crate::helpers::parse_config_toml(raw)["server"]["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(0)
}

/// Read `[server] allow_insecure_ws` (default false). Dev-only.
fn allow_insecure_ws_from_config_text(raw: &str) -> bool {
    crate::helpers::parse_config_toml(raw)["server"]["allowInsecureWs"]
        .as_bool()
        .unwrap_or(false)
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
pub async fn start(app: &AppHandle, state: &ServerState, advertise: bool) -> Result<u16, String> {
    use tauri::Manager;
    let info = crate::commands::host::local_host_info();
    let raw_config = server_config_raw(app);
    let mut identity = tls::identity();
    if identity.is_none() {
        tracing::warn!(
            target: "aethon::server",
            "TLS identity unavailable — serving the plain scaffold; remote pairing disabled"
        );
    }
    if allow_insecure_ws_from_config_text(&raw_config) {
        if cfg!(debug_assertions) {
            // Dev-only escape hatch for the browser dev loop (a desktop
            // browser can't pin a self-signed cert). Phones refuse the
            // missing TLS — this is never a production mode, so release
            // builds ignore the flag entirely rather than serving plain-
            // text pairing/tokens over the LAN.
            tracing::warn!(
                target: "aethon::server",
                "[server] allow_insecure_ws = true — serving WITHOUT TLS (dev build only)"
            );
            identity = None;
        } else {
            tracing::warn!(
                target: "aethon::server",
                "[server] allow_insecure_ws is ignored in release builds — keeping TLS"
            );
        }
    }
    let remote = Arc::clone(app.state::<Arc<remote::RemoteState>>().inner());
    let relay: Arc<dyn remote::relay::RelayExec> =
        Arc::new(remote::relay::TauriRelay::new(app.clone()));
    let (port, http_task) = http::serve(
        info.clone(),
        server_port_from_config_text(&raw_config),
        identity,
        remote,
        relay,
    )
    .await?;
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
