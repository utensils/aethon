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
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const SERVICE_TYPE: &str = "_aethon._tcp.local.";
const DEBOUNCE: Duration = Duration::from_millis(250);
const VERIFY_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Serialize, Clone)]
pub struct DiscoveredHost {
    pub id: String,
    pub hostname: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub port: u16,
    #[serde(rename = "fingerprintPrefix")]
    pub fingerprint_prefix: String,
    pub candidates: Vec<String>,
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
    let system_hostname = local_mdns_hostname().unwrap_or_else(|| "localhost.local".to_string());
    let host_label = system_hostname.trim_end_matches(".local");
    let hostname = advertised_mdns_hostname(fingerprint);
    let suffix = &fingerprint[..fingerprint.len().min(8)];
    let instance_name = format!("{display_name} ({host_label}, {suffix})");
    let version = env!("CARGO_PKG_VERSION");
    let local_info = crate::commands::host::local_host_info();
    let props = [
        ("version", version),
        ("name", display_name),
        ("fingerprint", fingerprint),
        ("hostId", local_info.id.as_str()),
    ];
    let service = ServiceInfo::new(
        SERVICE_TYPE,
        &instance_name,
        &format!("{hostname}."),
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

/// Fingerprint-derived service target hostname for Aethon's own mDNS
/// advertisement. Using the system LocalHostName as the target can collide on
/// networks where another Mac already owns `name.local`, which triggers macOS'
/// "local hostname is already in use" rename dialog. A synthetic hostname keeps
/// the service unique while TXT `name` retains the human display label.
pub(crate) fn advertised_mdns_hostname(fingerprint: &str) -> String {
    let suffix: String = fingerprint
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(12)
        .collect();
    let suffix = if suffix.is_empty() {
        "unknown".to_string()
    } else {
        suffix.to_ascii_lowercase()
    };
    format!("aethon-{suffix}.local")
}

/// Local host name that Bonjour can resolve, without the trailing dot.
pub(crate) fn local_mdns_hostname() -> Option<String> {
    let fallback = gethostname::gethostname().to_string_lossy().into_owned();
    local_mdns_hostname_from(system_local_hostname().as_deref(), &fallback)
}

fn local_mdns_hostname_from(preferred: Option<&str>, fallback: &str) -> Option<String> {
    preferred
        .and_then(normalize_mdns_hostname)
        .or_else(|| normalize_mdns_hostname(fallback))
}

fn normalize_mdns_hostname(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.to_ascii_lowercase().ends_with(".local") {
        Some(trimmed.to_string())
    } else {
        Some(format!("{trimmed}.local"))
    }
}

#[cfg(target_os = "macos")]
fn system_local_hostname() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "LocalHostName"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let hostname = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!hostname.is_empty()).then_some(hostname)
}

#[cfg(not(target_os = "macos"))]
fn system_local_hostname() -> Option<String> {
    None
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
        // `mdns` is owned by this task so the daemon stays alive for the
        // browser lifetime; ServiceFound below also uses it to force
        // resolution when the cache only has a PTR record.
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
                ServiceEvent::ServiceFound(_, fullname) => {
                    tracing::debug!(
                        target: "aethon::server::mdns",
                        "found service {fullname}; verifying"
                    );
                    let _ = mdns.verify(fullname, VERIFY_TIMEOUT);
                }
                ServiceEvent::ServiceResolved(info) => {
                    let fingerprint = info
                        .get_property_val_str("fingerprint")
                        .unwrap_or_default()
                        .to_string();
                    if fingerprint == local_fingerprint {
                        // mdns-sd echoes our own advertisement; skip it.
                        continue;
                    }
                    let Some(host) = discovered_host_from_service_info(&info) else {
                        tracing::debug!(
                            target: "aethon::server::mdns",
                            "ignoring unresolved service {}",
                            info.get_fullname()
                        );
                        continue;
                    };
                    let id = host.id.clone();
                    if let Some(remote) =
                        app.try_state::<std::sync::Arc<crate::server::remote::RemoteState>>()
                    {
                        let _ = remote.hosts.touch_candidates(&id, host.candidates.clone());
                        let _ = app.emit("remote-hosts-changed", HostRemoved { id: id.clone() });
                    }
                    let fullname = info.get_fullname().to_string();
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

fn discovered_host_from_service_info(info: &ServiceInfo) -> Option<DiscoveredHost> {
    let fingerprint = info
        .get_property_val_str("fingerprint")
        .unwrap_or_default()
        .to_string();
    if fingerprint.is_empty() {
        return None;
    }
    let hostname = info.get_hostname().trim_end_matches('.').to_string();
    if hostname.is_empty() {
        return None;
    }
    let name = info
        .get_property_val_str("name")
        .unwrap_or_default()
        .to_string();
    let display = if name.is_empty() {
        hostname
            .trim_end_matches(".local")
            .trim_end_matches(".lan")
            .to_string()
    } else {
        name
    };
    let port = info.get_port();
    Some(DiscoveredHost {
        id: format!("remote:{fingerprint}"),
        hostname: hostname.clone(),
        display_name: display,
        port,
        fingerprint_prefix: fingerprint,
        candidates: service_candidates(info, &hostname, port),
        last_seen: now_ms(),
    })
}

fn service_candidates(info: &ServiceInfo, hostname: &str, port: u16) -> Vec<String> {
    let mut out = vec![format!("{hostname}:{port}")];
    let mut addresses = info
        .get_addresses()
        .iter()
        .copied()
        .collect::<Vec<IpAddr>>();
    addresses.sort();
    for addr in addresses {
        let candidate = SocketAddr::new(addr, port).to_string();
        if !out.iter().any(|existing| existing == &candidate) {
            out.push(candidate);
        }
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_mdns_hostname_prefers_bonjour_local_hostname() {
        let hostname = local_mdns_hostname_from(Some("halcyon-3\n"), "halcyon").unwrap();

        assert_eq!(hostname, "halcyon-3.local");
    }

    #[test]
    fn local_mdns_hostname_does_not_duplicate_local_suffix() {
        let hostname = local_mdns_hostname_from(Some("halcyon-3.local."), "halcyon").unwrap();

        assert_eq!(hostname, "halcyon-3.local");
    }

    #[test]
    fn local_mdns_hostname_falls_back_to_unix_hostname() {
        let hostname = local_mdns_hostname_from(None, "halcyon").unwrap();

        assert_eq!(hostname, "halcyon.local");
    }

    #[test]
    fn advertised_mdns_hostname_is_fingerprint_scoped() {
        assert_eq!(
            advertised_mdns_hostname("AB:CD:EF:12:34"),
            "aethon-abcdef1234.local"
        );
        assert_eq!(advertised_mdns_hostname("::"), "aethon-unknown.local");
    }

    #[test]
    fn discovered_host_uses_txt_identity_and_resolved_candidates() {
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            "bender (bender-4, 3eb36a78)",
            "aethon-3eb36a78c099.local.",
            "192.168.1.143",
            54148,
            &[
                ("name", "bender"),
                (
                    "fingerprint",
                    "3eb36a78c09916acfc50c566fce3087c68ac8232a6cf9e59e5deb713fee0fdd5",
                ),
            ][..],
        )
        .unwrap();

        let host = discovered_host_from_service_info(&info).unwrap();

        assert_eq!(
            host.id,
            "remote:3eb36a78c09916acfc50c566fce3087c68ac8232a6cf9e59e5deb713fee0fdd5"
        );
        assert_eq!(host.display_name, "bender");
        assert_eq!(host.hostname, "aethon-3eb36a78c099.local");
        assert_eq!(host.candidates[0], "aethon-3eb36a78c099.local:54148");
        assert!(host.candidates.contains(&"192.168.1.143:54148".to_string()));
    }

    #[test]
    fn discovered_host_requires_fingerprint() {
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            "bender",
            "aethon-3eb36a78c099.local.",
            "192.168.1.143",
            54148,
            &[("name", "bender")][..],
        )
        .unwrap();

        assert!(discovered_host_from_service_info(&info).is_none());
    }
}
