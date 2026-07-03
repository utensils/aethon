//! Frontend control surface for the remote gateway: pairing lifecycle
//! and the paired-device list (Settings → Remote Devices).
//!
//! Pairing requires the TLS identity (clients pin its fingerprint — a
//! placeholder would pin nothing) and a running server (the QR payload
//! embeds the bound port).

use std::sync::Arc;

use tauri::{Emitter, State};

use crate::server::ServerState;
use crate::server::remote::hosts::PairedHostView;
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
    Ok(remote
        .devices
        .list()
        .into_iter()
        .map(|mut device| {
            device.connected = remote.is_device_live(&device.id);
            device
        })
        .collect())
}

#[tauri::command]
pub fn remote_device_revoke(
    id: String,
    remote: State<'_, Arc<RemoteState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    remote.devices.revoke(&id)?;
    // Token is dead for new connections; drop live ones immediately.
    remote.close_device(&id);
    let _ = app.emit("remote-devices-changed", serde_json::json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub fn remote_device_rename(
    id: String,
    name: String,
    remote: State<'_, Arc<RemoteState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    remote.devices.rename(&id, &name)?;
    let _ = app.emit("remote-devices-changed", serde_json::json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub fn remote_hosts_list(
    remote: State<'_, Arc<RemoteState>>,
) -> Result<Vec<PairedHostView>, String> {
    Ok(remote.hosts.list())
}

fn candidate_with_port(host: &str, port: u16) -> String {
    if host
        .rsplit_once(':')
        .is_some_and(|(_, p)| p.parse::<u16>().is_ok())
    {
        host.to_string()
    } else {
        format!("{host}:{port}")
    }
}

#[tauri::command]
pub async fn remote_host_pair(
    host: String,
    fingerprint: String,
    code: String,
    candidates: Option<Vec<String>>,
    server: State<'_, Arc<ServerState>>,
    remote: State<'_, Arc<RemoteState>>,
    app: tauri::AppHandle,
) -> Result<PairedHostView, String> {
    let local_info = crate::commands::host::local_host_info();
    let Some(port) = server.port().await else {
        return Err("local server is not running — start it before pairing a desktop host".into());
    };
    let reciprocal_token = pairing::new_device_token();
    let reciprocal_candidates = pairing::candidate_hosts(Some(&local_info.fingerprint))
        .into_iter()
        .map(|h| candidate_with_port(&h, port))
        .collect::<Vec<_>>();
    let local_name = local_info.display_name.clone();
    let mut pair_candidates = vec![host.clone()];
    if let Some(candidates) = candidates {
        pair_candidates.extend(candidates);
    }
    let (token, remote_info) = crate::server::remote::client::pair_desktop(
        &pair_candidates,
        &fingerprint,
        &code,
        &local_name,
        &local_info,
        &reciprocal_token,
        reciprocal_candidates,
    )
    .await?;
    let view = remote
        .hosts
        .upsert(remote_info.clone(), token, pair_candidates)?;
    let _ = remote
        .devices
        .add(&remote_info.display_name, "desktop", &reciprocal_token);
    if let Some(record) = remote.hosts.get(&view.id) {
        let cancel = remote.replace_host_forwarder(&view.id);
        crate::server::remote::client::spawn_event_forwarder(record, app.clone(), cancel);
    }
    let _ = app.emit("remote-hosts-changed", serde_json::json!({ "id": view.id }));
    Ok(view)
}

#[tauri::command]
pub fn remote_host_forget(
    id: String,
    remote: State<'_, Arc<RemoteState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    remote.hosts.forget(&id)?;
    remote.close_host_forwarder(&id);
    let _ = app.emit("remote-hosts-changed", serde_json::json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub fn remote_host_rename(
    id: String,
    name: String,
    remote: State<'_, Arc<RemoteState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    remote.hosts.rename(&id, &name)?;
    let _ = app.emit("remote-hosts-changed", serde_json::json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub async fn remote_host_reconnect(
    id: String,
    remote: State<'_, Arc<RemoteState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let host = remote
        .hosts
        .get(&id)
        .ok_or_else(|| format!("unknown remote host {id}"))?;
    let cancel = remote.replace_host_forwarder(&id);
    crate::server::remote::client::spawn_event_forwarder(host, app.clone(), cancel);
    let _ = app.emit("remote-hosts-changed", serde_json::json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub async fn remote_host_invoke(
    id: String,
    cmd: String,
    #[allow(non_snake_case)] args: serde_json::Value,
    remote: State<'_, Arc<RemoteState>>,
) -> Result<serde_json::Value, String> {
    let host = remote
        .hosts
        .get(&id)
        .ok_or_else(|| format!("unknown remote host {id}"))?;
    crate::server::remote::client::invoke(&host, &cmd, args).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProjectSnapshot {
    pub host_id: String,
    pub projects: serde_json::Value,
    pub icons: serde_json::Value,
}

#[tauri::command]
pub async fn remote_host_project_snapshot(
    id: String,
    remote: State<'_, Arc<RemoteState>>,
) -> Result<RemoteProjectSnapshot, String> {
    let host = remote
        .hosts
        .get(&id)
        .ok_or_else(|| format!("unknown remote host {id}"))?;
    let data = crate::server::remote::client::invoke(
        &host,
        "read_state",
        serde_json::json!({ "name": "projects.json" }),
    )
    .await?;
    let projects = parse_remote_state_json(&data, "remote projects.json")?;
    let icons_data = crate::server::remote::client::invoke(
        &host,
        "read_state",
        serde_json::json!({ "name": "project-icons.json" }),
    )
    .await;
    let icons = match icons_data {
        Ok(value) => match parse_remote_state_json(&value, "remote project-icons.json") {
            Ok(parsed) => parsed,
            Err(err) => {
                tracing::debug!(host_id = %id, error = %err, "remote project icon sidecar invalid");
                serde_json::json!({})
            }
        },
        Err(err) => {
            tracing::debug!(host_id = %id, error = %err, "remote project icon sidecar unavailable");
            serde_json::json!({})
        }
    };
    Ok(RemoteProjectSnapshot {
        host_id: id,
        projects,
        icons,
    })
}

fn parse_remote_state_json(
    value: &serde_json::Value,
    label: &str,
) -> Result<serde_json::Value, String> {
    match value {
        serde_json::Value::String(raw) => {
            if raw.trim().is_empty() {
                Ok(serde_json::json!({}))
            } else {
                serde_json::from_str(raw).map_err(|e| format!("{label}: {e}"))
            }
        }
        serde_json::Value::Null => Ok(serde_json::json!({})),
        serde_json::Value::Object(_) => Ok(value.clone()),
        _ => Err(format!("{label}: expected JSON object state")),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_remote_state_json;
    use serde_json::json;

    #[test]
    fn parse_remote_state_json_accepts_empty_state() {
        assert_eq!(
            parse_remote_state_json(&json!(""), "remote project-icons.json").unwrap(),
            json!({})
        );
    }

    #[test]
    fn parse_remote_state_json_decodes_string_state() {
        assert_eq!(
            parse_remote_state_json(
                &json!(r#"{"p1":"data:image/png;base64,AAAA"}"#),
                "remote project-icons.json"
            )
            .unwrap(),
            json!({ "p1": "data:image/png;base64,AAAA" })
        );
    }

    #[test]
    fn parse_remote_state_json_accepts_object_state() {
        assert_eq!(
            parse_remote_state_json(&json!({ "projects": [] }), "remote projects.json").unwrap(),
            json!({ "projects": [] })
        );
    }
}
