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
    lifecycle: Arc<Mutex<()>>,
    browser: Arc<Mutex<Option<mdns::BrowserHandle>>>,
}

impl ServerState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return lifecycle state from one lock acquisition so callers never
    /// observe a port from a different generation than `running`.
    pub async fn status(&self) -> (bool, Option<u16>) {
        let guard = self.inner.lock().await;
        (guard.is_some(), guard.as_ref().map(|handle| handle.port))
    }

    pub async fn port(&self) -> Option<u16> {
        self.inner.lock().await.as_ref().map(|h| h.port)
    }

    async fn set(&self, handle: ServerHandle) {
        let mut guard = self.inner.lock().await;
        if let Some(prev) = guard.take() {
            prev.http_task.abort();
            // Dropping prev.advertise_daemon stops the announcement.
        }
        *guard = Some(handle);
    }

    async fn start_once<F, Fut>(&self, starter: F) -> Result<u16, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<ServerHandle, String>>,
    {
        let _lifecycle = self.lifecycle.lock().await;
        if let Some(port) = self.port().await {
            return Ok(port);
        }
        let handle = starter().await?;
        let port = handle.port;
        self.set(handle).await;
        Ok(port)
    }

    pub async fn stop(&self) {
        // Serialize stop against an in-flight start. Without this gate a
        // start could publish a new handle immediately after stop returned.
        let _lifecycle = self.lifecycle.lock().await;
        let mut guard = self.inner.lock().await;
        if let Some(prev) = guard.take() {
            prev.http_task.abort();
        }
    }

    async fn start_browser_once(&self, app: AppHandle) -> Result<(), String> {
        let mut browser = self.browser.lock().await;
        if browser.is_none() {
            *browser = Some(mdns::start_browser(app)?);
        }
        Ok(())
    }

    /// Stop every long-lived network resource owned by this server state.
    /// `server_stop` intentionally leaves discovery running; app shutdown does
    /// not, so no browser task or mDNS daemon outlives the Tauri application.
    pub async fn shutdown(&self) {
        self.stop().await;
        let browser = self.browser.lock().await.take();
        if let Some(browser) = browser {
            browser.stop().await;
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
        if let Err(e) = state.start_browser_once(app.clone()).await {
            tracing::warn!(target: "aethon::server::mdns", "browser failed: {e}");
        }
    });
}

/// Read the shared `~/.aethon/config.toml` snapshot. The helper refreshes on
/// external edits and is explicitly invalidated by Aethon's Settings writer.
fn server_config_snapshot(app: &AppHandle) -> crate::helpers::ConfigSnapshot {
    use tauri::Manager;
    let Ok(home) = app.path().home_dir() else {
        return crate::helpers::ConfigSnapshot {
            raw: String::new(),
            parsed: crate::helpers::parse_config_toml(""),
        };
    };
    let user_dir =
        crate::helpers::aethon_dir(Some(home.clone())).unwrap_or_else(|| home.join(".aethon"));
    crate::helpers::read_config_snapshot(&user_dir.join("config.toml"))
}

/// Read `[server] enabled` from `~/.aethon/config.toml` (default true).
fn server_enabled(app: &AppHandle) -> bool {
    server_config_snapshot(app).parsed["server"]["enabled"]
        .as_bool()
        .unwrap_or(true)
}

#[cfg(test)]
fn server_enabled_from_config_text(raw: &str) -> bool {
    crate::helpers::parse_config_toml(raw)["server"]["enabled"]
        .as_bool()
        .unwrap_or(true)
}

/// Read `[server] keep_alive` (default false).
pub fn keep_alive_enabled(app: &AppHandle) -> bool {
    server_config_snapshot(app).parsed["server"]["keepAlive"]
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
    let port = state
        .start_once(|| async {
            let info = crate::commands::host::local_host_info();
            let config = server_config_snapshot(app);
            let mut identity = tls::identity();
            if identity.is_none() {
                tracing::warn!(
                    target: "aethon::server",
                    "TLS identity unavailable — serving the plain scaffold; remote pairing disabled"
                );
            }
            if config.parsed["server"]["allowInsecureWs"]
                .as_bool()
                .unwrap_or(false)
            {
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
                config.parsed["server"]["port"]
                    .as_u64()
                    .and_then(|port| u16::try_from(port).ok())
                    .unwrap_or(0),
                identity,
                remote,
                relay,
                app.clone(),
            )
            .await?;
            let advertise_daemon = if advertise {
                mdns::advertise(&info.display_name, port, &info.fingerprint)
                    .map(Some)
                    .map_err(|e| format!("mdns advertise failed: {e}"))
            } else {
                Ok(None)
            };
            assemble_handle(port, http_task, advertise_daemon)
        })
        .await?;
    tracing::info!(target: "aethon::server", "listening on 0.0.0.0:{port}");
    Ok(port)
}

/// Transfer the bound HTTP task into a published server handle. If a later
/// startup stage fails, abort the task before returning so the listener does
/// not survive without a handle that can stop it.
fn assemble_handle(
    port: u16,
    http_task: JoinHandle<()>,
    advertise_daemon: Result<Option<mdns_sd::ServiceDaemon>, String>,
) -> Result<ServerHandle, String> {
    match advertise_daemon {
        Ok(advertise_daemon) => Ok(ServerHandle {
            port,
            http_task,
            advertise_daemon,
        }),
        Err(error) => {
            http_task.abort();
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::{
        ServerHandle, ServerState, assemble_handle, server_enabled_from_config_text,
        start_on_boot_if_enabled,
    };

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

    #[tokio::test]
    async fn failed_advertisement_aborts_bound_http_task() {
        let task = tokio::spawn(std::future::pending::<()>());
        let abort_handle = task.abort_handle();

        let result = assemble_handle(
            123,
            tauri::async_runtime::JoinHandle::Tokio(task),
            Err("advertise failed".into()),
        );

        assert!(result.is_err());
        tokio::task::yield_now().await;
        assert!(abort_handle.is_finished());
    }

    #[tokio::test]
    async fn status_is_a_single_consistent_snapshot() {
        let state = ServerState::new();
        assert_eq!(state.status().await, (false, None));

        state
            .set(ServerHandle {
                port: 4242,
                http_task: tauri::async_runtime::JoinHandle::Tokio(tokio::spawn(
                    std::future::pending(),
                )),
                advertise_daemon: None,
            })
            .await;

        assert_eq!(state.status().await, (true, Some(4242)));
        state.stop().await;
        assert_eq!(state.status().await, (false, None));
    }

    #[tokio::test]
    async fn concurrent_starts_share_one_server_generation() {
        let state = Arc::new(ServerState::new());
        let starts = Arc::new(AtomicUsize::new(0));
        let mut callers = Vec::new();

        for _ in 0..2 {
            let state = Arc::clone(&state);
            let starts = Arc::clone(&starts);
            callers.push(tokio::spawn(async move {
                state
                    .start_once(|| async move {
                        starts.fetch_add(1, Ordering::SeqCst);
                        tokio::task::yield_now().await;
                        Ok(ServerHandle {
                            port: 4242,
                            http_task: tauri::async_runtime::JoinHandle::Tokio(tokio::spawn(
                                std::future::pending(),
                            )),
                            advertise_daemon: None,
                        })
                    })
                    .await
            }));
        }

        for caller in callers {
            assert_eq!(caller.await.unwrap(), Ok(4242));
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        state.stop().await;
    }
}
