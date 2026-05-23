//! Host identity for the frontend's HOSTS sidebar section.
//!
//! `host_info` returns a stable id + display name for the local machine.
//! The id mixes the platform machine-uuid with `gethostname()` so we
//! survive hostname rename and reinstall, falling back to a hash of the
//! hostname if neither uuid source is available.
//!
//! The fingerprint is a placeholder until the pairing PR lands — same
//! shape as Claudette's mdns TXT record so the wire format is forward
//! compatible.

use serde::Serialize;
use sha1::{Digest, Sha1};
use std::process::Command;

#[derive(Debug, Serialize, Clone)]
pub struct HostInfo {
    pub id: String,
    pub hostname: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub fingerprint: String,
}

fn machine_uuid() -> Option<String> {
    if cfg!(target_os = "linux") {
        for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(s) = std::fs::read_to_string(path) {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        None
    } else if cfg!(target_os = "macos") {
        // `ioreg` is always present on macOS; output line looks like
        // `"IOPlatformUUID" = "ABC123-..."`.
        let out = Command::new("ioreg")
            .args(["-d2", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if line.contains("IOPlatformUUID")
                && let Some(rhs) = line.split('=').nth(1)
            {
                let uuid = rhs.trim().trim_matches('"');
                if !uuid.is_empty() {
                    return Some(uuid.to_string());
                }
            }
        }
        None
    } else if cfg!(target_os = "windows") {
        // Falls back to hostname-hash on Windows for now — pairing PR
        // can switch to MachineGuid registry read if/when we ship Windows.
        None
    } else {
        None
    }
}

fn hostname_string() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

fn pretty_display(hostname: &str) -> String {
    hostname
        .trim_end_matches(".local")
        .trim_end_matches(".lan")
        .to_string()
}

fn stable_id(hostname: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(b"aethon-host-v1\n");
    if let Some(uuid) = machine_uuid() {
        hasher.update(uuid.as_bytes());
        hasher.update(b"\n");
    }
    hasher.update(hostname.as_bytes());
    let digest = hasher.finalize();
    let short: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("local:{short}")
}

fn fingerprint_placeholder(id: &str) -> String {
    // Deterministic per-host placeholder so two boots of the same Aethon
    // advertise the same TXT value. Real cert fingerprints replace this
    // when pairing lands.
    let mut h = Sha1::new();
    h.update(b"aethon-fingerprint-v0\n");
    h.update(id.as_bytes());
    let digest = h.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn local_host_info() -> HostInfo {
    let hostname = hostname_string();
    let display_name = pretty_display(&hostname);
    let id = stable_id(&hostname);
    let fingerprint = fingerprint_placeholder(&id);
    HostInfo {
        id,
        hostname,
        display_name,
        fingerprint,
    }
}

#[tauri::command]
pub fn host_info() -> Result<HostInfo, String> {
    Ok(local_host_info())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_info_has_stable_shape() {
        let info = local_host_info();
        assert!(info.id.starts_with("local:"));
        assert!(!info.hostname.is_empty());
        assert!(!info.display_name.is_empty());
        assert_eq!(info.fingerprint.len(), 16);
    }

    #[test]
    fn pretty_display_trims_local_suffix() {
        assert_eq!(pretty_display("halcyon.local"), "halcyon");
        assert_eq!(pretty_display("halcyon.lan"), "halcyon");
        assert_eq!(pretty_display("halcyon"), "halcyon");
    }

    #[test]
    fn stable_id_deterministic_for_same_hostname() {
        let a = stable_id("halcyon.local");
        let b = stable_id("halcyon.local");
        assert_eq!(a, b);
    }
}
