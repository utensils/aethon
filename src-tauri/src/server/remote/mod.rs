//! Remote-client gateway (paired devices over the LAN).
//!
//! Grows the scaffold in `server/` into an authenticated transport for
//! companion clients (iOS app): TLS + pairing, a WebSocket protocol
//! (`protocol`/`ws`) that relays an allowlisted subset of the Tauri
//! command surface (`policy`/`relay`), and an event hub (`events`) that
//! fans Tauri events out to connected devices.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub mod client;
pub mod devices;
pub mod events;
pub mod hosts;
pub mod pairing;
pub mod policy;
pub mod protocol;
pub mod relay;
pub mod ws;

#[cfg(test)]
mod integration_tests;

use devices::DeviceStore;
use events::EventHub;
use hosts::PairedHostStore;
use pairing::PairingSession;
use tokio::sync::Notify;

/// Managed by Tauri (`.manage(Arc<RemoteState>)`) and shared with the
/// axum router; owns everything the gateway needs across connections.
pub struct RemoteState {
    pub devices: DeviceStore,
    pub hosts: PairedHostStore,
    pub pairing: Mutex<Option<PairingSession>>,
    pub hub: Arc<EventHub>,
    /// Live-connection close signals keyed by device id, so revocation
    /// can drop a device's sessions immediately (`bye revoked`).
    live: Mutex<HashMap<String, Vec<Arc<Notify>>>>,
    /// Invoke rate limiters keyed by device id — shared across a
    /// device's sessions so opening extra sockets doesn't multiply the
    /// budget. Pruned when a device's last session deregisters.
    rate: Mutex<HashMap<String, ws::RateLimiter>>,
    /// Outbound desktop-host event forwarders keyed by paired host id.
    /// Reconnect replaces the old cancel handle so the frontend can
    /// explicitly refresh candidates without spawning duplicate streams.
    host_forwarders: Mutex<HashMap<String, Arc<Notify>>>,
}

impl RemoteState {
    /// Production state, persisting devices under `~/.aethon/remote/`.
    pub fn new() -> Self {
        Self::with_store(DeviceStore::load(crate::server::tls::default_remote_dir()))
    }

    fn with_store(devices: DeviceStore) -> Self {
        let remote_dir = crate::server::tls::default_remote_dir();
        Self {
            devices,
            hosts: PairedHostStore::load(remote_dir),
            pairing: Mutex::new(None),
            hub: Arc::new(EventHub::new()),
            live: Mutex::new(HashMap::new()),
            rate: Mutex::new(HashMap::new()),
            host_forwarders: Mutex::new(HashMap::new()),
        }
    }

    /// Ephemeral state for tests.
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            devices: DeviceStore::load(None),
            hosts: PairedHostStore::load(None),
            pairing: Mutex::new(None),
            hub: Arc::new(EventHub::new()),
            live: Mutex::new(HashMap::new()),
            rate: Mutex::new(HashMap::new()),
            host_forwarders: Mutex::new(HashMap::new()),
        }
    }

    /// Register a live connection; the returned handle fires when the
    /// device is revoked.
    pub fn register_live(&self, device_id: &str) -> Arc<Notify> {
        let notify = Arc::new(Notify::new());
        if let Ok(mut live) = self.live.lock() {
            live.entry(device_id.to_string())
                .or_default()
                .push(Arc::clone(&notify));
        }
        notify
    }

    pub fn deregister_live(&self, device_id: &str, handle: &Arc<Notify>) {
        let Ok(mut live) = self.live.lock() else {
            return;
        };
        if let Some(handles) = live.get_mut(device_id) {
            handles.retain(|h| !Arc::ptr_eq(h, handle));
            if handles.is_empty() {
                live.remove(device_id);
                if let Ok(mut rate) = self.rate.lock() {
                    rate.remove(device_id);
                }
            }
        }
    }

    pub fn is_device_live(&self, device_id: &str) -> bool {
        self.live
            .lock()
            .map(|live| {
                live.get(device_id)
                    .is_some_and(|handles| !handles.is_empty())
            })
            .unwrap_or(false)
    }

    /// Record an invoke against the device's shared rate budget;
    /// `false` when its current window is exhausted. Fails open on a
    /// poisoned lock — the limiter is flood protection, not auth, and
    /// bricking every remote invoke would be the worse failure.
    pub fn allow_invoke(&self, device_id: &str) -> bool {
        let Ok(mut rate) = self.rate.lock() else {
            return true;
        };
        rate.entry(device_id.to_string())
            .or_insert_with(ws::RateLimiter::new)
            .allow()
    }

    /// Close every live session for a device (post-revocation).
    /// `notify_one` (not `notify_waiters`) so the signal survives the
    /// startup window: if the session task hasn't reached
    /// `revoked.notified()` yet, a permit is stored and the next await
    /// completes immediately — `notify_waiters` would drop it and the
    /// socket would linger until its next reconnect.
    pub fn close_device(&self, device_id: &str) {
        let Ok(live) = self.live.lock() else {
            return;
        };
        if let Some(handles) = live.get(device_id) {
            for handle in handles {
                handle.notify_one();
            }
        }
    }

    pub fn replace_host_forwarder(&self, host_id: &str) -> Arc<Notify> {
        let notify = Arc::new(Notify::new());
        if let Ok(mut forwarders) = self.host_forwarders.lock()
            && let Some(old) = forwarders.insert(host_id.to_string(), Arc::clone(&notify))
        {
            old.notify_one();
        }
        notify
    }

    pub fn close_host_forwarder(&self, host_id: &str) {
        if let Ok(mut forwarders) = self.host_forwarders.lock()
            && let Some(handle) = forwarders.remove(host_id)
        {
            handle.notify_one();
        }
    }
}

impl Default for RemoteState {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether closing the last window should keep the app alive:
/// `[server] keep_alive = true` AND at least one non-revoked paired
/// device. Without a device the flag is inert, so a fresh install never
/// turns into an invisible background process.
pub fn keep_alive_active(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    if !crate::server::keep_alive_enabled(app) {
        return false;
    }
    let Some(remote) = app.try_state::<Arc<RemoteState>>() else {
        return false;
    };
    remote.devices.list().iter().any(|d| !d.revoked)
}

/// Axum router state for the gateway routes.
#[derive(Clone)]
pub struct GatewayCtx {
    pub info: crate::commands::host::HostInfo,
    pub remote: Arc<RemoteState>,
    pub relay: Arc<dyn relay::RelayExec>,
    pub device_changed: Arc<dyn Fn(&devices::DeviceView) + Send + Sync>,
    pub host_changed: Arc<dyn Fn(&str) + Send + Sync>,
}
