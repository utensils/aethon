//! Frontend control surface for the remote gateway: pairing lifecycle
//! and the paired-device list (Settings → Remote Devices).
//!
//! Pairing requires the TLS identity (clients pin its fingerprint — a
//! placeholder would pin nothing) and a running server (the QR payload
//! embeds the bound port).

use std::sync::Arc;

use tauri::State;

use crate::server::ServerState;
use crate::server::remote::pairing::{self, PairingBegin};
use crate::server::remote::{RemoteState, devices::DeviceView};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub tls_active: bool,
    pub fingerprint: Option<String>,
    pub pairing_active: bool,
    pub devices: usize,
}

#[tauri::command]
pub async fn remote_status(
    server: State<'_, Arc<ServerState>>,
    remote: State<'_, Arc<RemoteState>>,
) -> Result<RemoteStatus, String> {
    let identity = crate::server::tls::identity();
    Ok(RemoteStatus {
        running: server.is_running().await,
        port: server.port().await,
        tls_active: identity.is_some(),
        fingerprint: identity.map(|i| i.fingerprint.clone()),
        pairing_active: remote.pairing.lock().map_err(|e| e.to_string())?.is_some(),
        devices: remote.devices.list().len(),
    })
}

#[tauri::command]
pub async fn remote_pairing_begin(
    server: State<'_, Arc<ServerState>>,
    remote: State<'_, Arc<RemoteState>>,
) -> Result<PairingBegin, String> {
    let Some(identity) = crate::server::tls::identity() else {
        return Err("TLS identity unavailable — pairing is disabled on this host".to_string());
    };
    let Some(port) = server.port().await else {
        return Err(
            "server is not running — start it in Settings → Server before pairing".to_string(),
        );
    };
    let display_name = crate::commands::host::local_host_info().display_name;
    let (session, begin) = pairing::begin(&display_name, port, &identity.fingerprint);
    *remote.pairing.lock().map_err(|e| e.to_string())? = Some(session);
    Ok(begin)
}

#[tauri::command]
pub fn remote_pairing_cancel(remote: State<'_, Arc<RemoteState>>) -> Result<(), String> {
    *remote.pairing.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn remote_devices_list(remote: State<'_, Arc<RemoteState>>) -> Result<Vec<DeviceView>, String> {
    Ok(remote.devices.list())
}

#[tauri::command]
pub fn remote_device_revoke(id: String, remote: State<'_, Arc<RemoteState>>) -> Result<(), String> {
    remote.devices.revoke(&id)?;
    // Token is dead for new connections; drop live ones immediately.
    remote.close_device(&id);
    Ok(())
}

#[tauri::command]
pub fn remote_device_rename(
    id: String,
    name: String,
    remote: State<'_, Arc<RemoteState>>,
) -> Result<(), String> {
    remote.devices.rename(&id, &name)
}
