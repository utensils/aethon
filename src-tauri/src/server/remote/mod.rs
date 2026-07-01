//! Remote-client gateway (paired devices over the LAN).
//!
//! Grows the scaffold in `server/` into an authenticated transport for
//! companion clients (iOS app): TLS + pairing, a WebSocket protocol
//! (`protocol`/`ws`) that relays an allowlisted subset of the Tauri
//! command surface (`policy`/`relay`), and an event hub (`events`) that
//! fans Tauri events out to connected devices.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub mod devices;
pub mod events;
pub mod pairing;
pub mod policy;
pub mod protocol;
pub mod relay;
pub mod ws;

#[cfg(test)]
mod integration_tests;

use devices::DeviceStore;
use events::EventHub;
use pairing::PairingSession;
use tokio::sync::Notify;

/// Managed by Tauri (`.manage(Arc<RemoteState>)`) and shared with the
/// axum router; owns everything the gateway needs across connections.
pub struct RemoteState {
    pub devices: DeviceStore,
    pub pairing: Mutex<Option<PairingSession>>,
    pub hub: Arc<EventHub>,
    /// Live-connection close signals keyed by device id, so revocation
    /// can drop a device's sessions immediately (`bye revoked`).
    live: Mutex<HashMap<String, Vec<Arc<Notify>>>>,
}

impl RemoteState {
    /// Production state, persisting devices under `~/.aethon/remote/`.
    pub fn new() -> Self {
        Self::with_store(DeviceStore::load(crate::server::tls::default_remote_dir()))
    }

    fn with_store(devices: DeviceStore) -> Self {
        Self {
            devices,
            pairing: Mutex::new(None),
            hub: Arc::new(EventHub::new()),
            live: Mutex::new(HashMap::new()),
        }
    }

    /// Ephemeral state for tests.
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::with_store(DeviceStore::load(None))
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
            }
        }
    }

    /// Close every live session for a device (post-revocation).
    pub fn close_device(&self, device_id: &str) {
        let Ok(live) = self.live.lock() else {
            return;
        };
        if let Some(handles) = live.get(device_id) {
            for handle in handles {
                handle.notify_waiters();
            }
        }
    }
}

impl Default for RemoteState {
    fn default() -> Self {
        Self::new()
    }
}

/// Axum router state for the gateway routes.
#[derive(Clone)]
pub struct GatewayCtx {
    pub info: crate::commands::host::HostInfo,
    pub remote: Arc<RemoteState>,
    pub relay: Arc<dyn relay::RelayExec>,
}
