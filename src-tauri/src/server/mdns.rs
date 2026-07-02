//! mDNS advertise + browse for `_aethon._tcp.local.`.
//!
//! Advertise: a single `ServiceInfo` registration with TXT records
//! `{ version, name, fingerprint }`. Caller holds the returned
//! `ServiceDaemon` for the lifetime of the announcement.
//!
//! Browse: a long-lived task that emits `host-discovered` /
//! `host-removed` Tauri events whenever a peer resolves or drops.
//! Resolution events are coalesced through a 250ms debounce buffer so a
//! noisy LAN doesn't fan out hundreds of emits per second.

use std::collections::HashMap;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const SERVICE_TYPE: &str = "_aethon._tcp.local.";
const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Debug, Serialize, Clone)]
pub struct DiscoveredHost {
    pub id: String,
    pub hostname: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub port: u16,
    #[serde(rename = "fingerprintPrefix")]
    pub fingerprint_prefix: String,
    #[serde(rename = "lastSeen")]
    pub last_seen: u64,
}

#[derive(Debug, Serialize, Clone)]
struct HostRemoved {
    id: String,
}

/// Advertise this Aethon instance. Drop the returned `ServiceDaemon` to
/// stop announcing. The daemon must outlive the announcement.
pub fn advertise(
    display_name: &str,
    port: u16,
    fingerprint: &str,
) -> Result<ServiceDaemon, Box<dyn std::error::Error>> {
    let mdns = ServiceDaemon::new()?;
    let hostname = gethostname::gethostname().to_string_lossy().to_string();
    let instance_name = format!("{display_name} ({hostname})");
    let version = env!("CARGO_PKG_VERSION");
    let props = [
        ("version", version),
        ("name", display_name),
        ("fingerprint", fingerprint),
    ];
    let service = ServiceInfo::new(
        SERVICE_TYPE,
        &instance_name,
        &format!("{hostname}.local."),
        // No static IP: enable_addr_auto attaches every non-loopback
        // interface address (and tracks changes). Without it the
        // service registers with NO A/AAAA records — mdns-sd accepts
        // that silently, but browsers can never resolve it, so the
        // announcement is invisible on the wire.
        "",
        port,
        &props[..],
    )?
    .enable_addr_auto();
    mdns.register(service)?;
    Ok(mdns)
}

/// Start the LAN browser. Resolution events are debounced before they
/// fan out as Tauri events so the frontend never has to dedupe.
pub fn start_browser(app: AppHandle) -> Result<(), String> {
    // Compare by fingerprint, NOT by id — the browser builds remote ids
    // as `remote:<fingerprint>` while host_info returns `local:<short>`.
    // A pure-id check would never match and we'd surface ourselves as
    // a remote (codex P2 review finding).
    let local_fingerprint = crate::commands::host::local_host_info().fingerprint;
    let mdns = ServiceDaemon::new().map_err(|e| format!("daemon: {e}"))?;
    let receiver = mdns
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("browse: {e}"))?;
    tauri::async_runtime::spawn(async move {
        // Hold the daemon alive for the task lifetime.
        let _mdns = mdns;
        let mut fullname_to_id: HashMap<String, String> = HashMap::new();
        let mut pending: HashMap<String, DiscoveredHost> = HashMap::new();
        let mut next_flush: Option<tokio::time::Instant> = None;
        loop {
            // Either receive an event or wake up to flush the debounce buffer.
            let event = if let Some(deadline) = next_flush {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => {
                        flush(&app, &mut pending);
                        next_flush = None;
                        continue;
                    }
                    ev = receiver.recv_async() => ev,
                }
            } else {
                receiver.recv_async().await
            };
            let Ok(event) = event else {
                break;
            };
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let name = info
                        .get_property_val_str("name")
                        .unwrap_or_default()
                        .to_string();
                    let fingerprint = info
                        .get_property_val_str("fingerprint")
                        .unwrap_or_default()
                        .to_string();
                    let hostname = info.get_hostname().trim_end_matches('.').to_string();
                    let port = info.get_port();
                    let fullname = info.get_fullname().to_string();
                    if fingerprint == local_fingerprint {
                        // mdns-sd echoes our own advertisement; skip it.
                        continue;
                    }
                    let id = format!("remote:{fingerprint}");
                    let display = if name.is_empty() {
                        hostname
                            .trim_end_matches(".local")
                            .trim_end_matches(".lan")
                            .to_string()
                    } else {
                        name.clone()
                    };
                    let host = DiscoveredHost {
                        id: id.clone(),
                        hostname,
                        display_name: display,
                        port,
                        fingerprint_prefix: fingerprint,
                        last_seen: now_ms(),
                    };
                    fullname_to_id.insert(fullname, id.clone());
                    pending.insert(id, host);
                    next_flush = Some(tokio::time::Instant::now() + DEBOUNCE);
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    if let Some(id) = fullname_to_id.remove(&fullname) {
                        pending.remove(&id);
                        let _ = app.emit("host-removed", HostRemoved { id });
                    }
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn flush(app: &AppHandle, pending: &mut HashMap<String, DiscoveredHost>) {
    for (_, host) in pending.drain() {
        let _ = app.emit("host-discovered", host);
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
