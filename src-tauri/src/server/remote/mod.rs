//! Remote-client gateway (paired devices over the LAN).
//!
//! Grows the scaffold in `server/` into an authenticated transport for
//! companion clients (iOS app): TLS + pairing, a WebSocket protocol that
//! relays an allowlisted subset of the Tauri command surface, and an
//! event hub that fans Tauri events out to connected devices.

use std::sync::{Arc, Mutex};

pub mod devices;
pub mod events;
pub mod pairing;

use devices::DeviceStore;
use events::EventHub;
use pairing::PairingSession;

/// Managed by Tauri (`.manage(Arc<RemoteState>)`) and shared with the
/// axum router; owns everything the gateway needs across connections.
pub struct RemoteState {
    pub devices: DeviceStore,
    pub pairing: Mutex<Option<PairingSession>>,
    // TODO(remote-gateway): read by the WS connection layer later on
    // this branch; drop the allow when ws.rs lands.
    #[allow(dead_code)]
    pub hub: Arc<EventHub>,
}

impl RemoteState {
    /// Production state, persisting devices under `~/.aethon/remote/`.
    pub fn new() -> Self {
        Self {
            devices: DeviceStore::load(crate::server::tls::default_remote_dir()),
            pairing: Mutex::new(None),
            hub: Arc::new(EventHub::new()),
        }
    }

    /// Ephemeral state for tests.
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            devices: DeviceStore::load(None),
            pairing: Mutex::new(None),
            hub: Arc::new(EventHub::new()),
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
}
