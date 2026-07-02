//! Bonjour discovery of running desktops (`_aethon._tcp`).
//!
//! Uses the dnssd C API (libSystem) — browse + resolve route through the
//! OS mDNSResponder daemon, which is the sanctioned path on iOS: it needs
//! only the `NSBonjourServices` + `NSLocalNetworkUsageDescription` keys
//! already in the Info.plist. A raw-multicast crate (mdns-sd) would need
//! the restricted `com.apple.developer.networking.multicast` entitlement.
//!
//! Deliberately a snapshot, not a stream: `discovery_scan` browses for a
//! bounded window and returns everything it resolved. The ConnectScreen
//! polls it while visible, which sidesteps thread lifetime across iOS
//! backgrounding and needs no start/stop pair or remove-tracking.

use std::time::Duration;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDesktop {
    /// `remote:<fingerprint>` — mirrors the desktop's discovery ids.
    pub id: String,
    /// TXT `name`, falling back to the hostname sans `.local`.
    pub name: String,
    /// `<hostname>:<port>` — ready for `gateway_pair` / `MobileConnection.host`.
    pub host: String,
    pub hostname: String,
    pub port: u16,
    /// Full SHA-256 cert fingerprint from TXT — what the phone pins.
    pub fingerprint: String,
    pub version: String,
}

#[tauri::command]
pub async fn discovery_scan(timeout_ms: Option<u32>) -> Result<Vec<DiscoveredDesktop>, String> {
    let timeout = u64::from(timeout_ms.unwrap_or(2500).clamp(500, 10_000));
    tauri::async_runtime::spawn_blocking(move || scan_blocking(Duration::from_millis(timeout)))
        .await
        .map_err(|e| format!("discovery task failed: {e}"))?
}

/// TXT record wire format: repeated `[len][key=value]` entries.
/// Zero-length and `=`-less entries are skipped, truncated ones end the
/// parse.
fn parse_txt(bytes: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let len = bytes[i] as usize;
        i += 1;
        if len == 0 {
            continue;
        }
        if i + len > bytes.len() {
            break;
        }
        let entry = &bytes[i..i + len];
        i += len;
        if let Some(eq) = entry.iter().position(|&b| b == b'=') {
            out.push((
                String::from_utf8_lossy(&entry[..eq]).into_owned(),
                String::from_utf8_lossy(&entry[eq + 1..]).into_owned(),
            ));
        }
    }
    out
}

/// Build the wire shape from one resolved service. `None` when the TXT
/// carries no fingerprint — without it the phone can't pin, so the
/// entry is useless (and likely not an Aethon desktop at all).
fn desktop_from_resolved(
    hosttarget: &str,
    port: u16,
    txt: &[(String, String)],
) -> Option<DiscoveredDesktop> {
    let get = |k: &str| {
        txt.iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let fingerprint = get("fingerprint");
    if fingerprint.is_empty() {
        return None;
    }
    let hostname = hosttarget.trim_end_matches('.').to_string();
    let name = {
        let n = get("name");
        if n.is_empty() {
            hostname.trim_end_matches(".local").to_string()
        } else {
            n
        }
    };
    Some(DiscoveredDesktop {
        id: format!("remote:{fingerprint}"),
        name,
        host: format!("{hostname}:{port}"),
        hostname,
        port,
        fingerprint,
        version: get("version"),
    })
}

#[cfg(target_vendor = "apple")]
fn scan_blocking(timeout: Duration) -> Result<Vec<DiscoveredDesktop>, String> {
    dnssd::scan(timeout)
}

#[cfg(not(target_vendor = "apple"))]
fn scan_blocking(_timeout: Duration) -> Result<Vec<DiscoveredDesktop>, String> {
    Err("discovery unsupported on this platform".into())
}

#[cfg(target_vendor = "apple")]
mod dnssd {
    //! Minimal FFI over the stable dnssd C API. All callbacks fire
    //! synchronously inside `DNSServiceProcessResult`, so the `Scan`
    //! state behind the context pointers never leaves this thread.

    use std::ffi::{CStr, CString, c_char, c_void};
    use std::time::{Duration, Instant};

    use super::{DiscoveredDesktop, desktop_from_resolved, parse_txt};

    type DNSServiceRef = *mut c_void;
    type DNSServiceFlags = u32;
    type DNSServiceErrorType = i32;

    const FLAG_ADD: DNSServiceFlags = 0x2;
    const SERVICE_TYPE: &CStr = c"_aethon._tcp";

    type BrowseReply = unsafe extern "C" fn(
        sd_ref: DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        error: DNSServiceErrorType,
        service_name: *const c_char,
        regtype: *const c_char,
        reply_domain: *const c_char,
        context: *mut c_void,
    );

    type ResolveReply = unsafe extern "C" fn(
        sd_ref: DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        error: DNSServiceErrorType,
        fullname: *const c_char,
        hosttarget: *const c_char,
        port_be: u16,
        txt_len: u16,
        txt_record: *const u8,
        context: *mut c_void,
    );

    unsafe extern "C" {
        fn DNSServiceBrowse(
            sd_ref: *mut DNSServiceRef,
            flags: DNSServiceFlags,
            interface_index: u32,
            regtype: *const c_char,
            domain: *const c_char,
            callback: BrowseReply,
            context: *mut c_void,
        ) -> DNSServiceErrorType;
        fn DNSServiceResolve(
            sd_ref: *mut DNSServiceRef,
            flags: DNSServiceFlags,
            interface_index: u32,
            name: *const c_char,
            regtype: *const c_char,
            domain: *const c_char,
            callback: ResolveReply,
            context: *mut c_void,
        ) -> DNSServiceErrorType;
        fn DNSServiceRefSockFD(sd_ref: DNSServiceRef) -> i32;
        fn DNSServiceProcessResult(sd_ref: DNSServiceRef) -> DNSServiceErrorType;
        fn DNSServiceRefDeallocate(sd_ref: DNSServiceRef);
    }

    /// A browse hit waiting for its resolve to be started.
    struct PendingResolve {
        name: CString,
        regtype: CString,
        domain: CString,
        interface_index: u32,
    }

    /// One in-flight resolve; `done` flips inside the callback.
    struct ResolveSlot {
        service: DNSServiceRef,
        done: bool,
        result: Option<DiscoveredDesktop>,
    }

    #[derive(Default)]
    struct Scan {
        pending: Vec<PendingResolve>,
    }

    unsafe extern "C" fn browse_reply(
        _sd_ref: DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        error: DNSServiceErrorType,
        service_name: *const c_char,
        regtype: *const c_char,
        reply_domain: *const c_char,
        context: *mut c_void,
    ) {
        if error != 0 || flags & FLAG_ADD == 0 {
            return;
        }
        let scan = unsafe { &mut *(context as *mut Scan) };
        let copy = |p: *const c_char| unsafe { CStr::from_ptr(p) }.to_owned();
        scan.pending.push(PendingResolve {
            name: copy(service_name),
            regtype: copy(regtype),
            domain: copy(reply_domain),
            interface_index,
        });
    }

    unsafe extern "C" fn resolve_reply(
        _sd_ref: DNSServiceRef,
        _flags: DNSServiceFlags,
        _interface_index: u32,
        error: DNSServiceErrorType,
        _fullname: *const c_char,
        hosttarget: *const c_char,
        port_be: u16,
        txt_len: u16,
        txt_record: *const u8,
        context: *mut c_void,
    ) {
        let slot = unsafe { &mut *(context as *mut ResolveSlot) };
        slot.done = true;
        if error != 0 {
            return;
        }
        let hosttarget = unsafe { CStr::from_ptr(hosttarget) }.to_string_lossy();
        let txt = if txt_record.is_null() {
            Vec::new()
        } else {
            parse_txt(unsafe { std::slice::from_raw_parts(txt_record, txt_len as usize) })
        };
        slot.result = desktop_from_resolved(&hosttarget, u16::from_be(port_be), &txt);
    }

    pub fn scan(timeout: Duration) -> Result<Vec<DiscoveredDesktop>, String> {
        let deadline = Instant::now() + timeout;
        let mut scan = Box::new(Scan::default());

        let mut browse: DNSServiceRef = std::ptr::null_mut();
        let err = unsafe {
            DNSServiceBrowse(
                &mut browse,
                0,
                0,
                SERVICE_TYPE.as_ptr(),
                std::ptr::null(),
                browse_reply,
                (&mut *scan) as *mut Scan as *mut c_void,
            )
        };
        if err != 0 {
            return Err(format!("DNSServiceBrowse failed: {err}"));
        }

        // Slots are boxed so their addresses stay stable for the C
        // callbacks while the Vec grows.
        let mut slots: Vec<Box<ResolveSlot>> = Vec::new();

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }

            // Start resolves for any new browse hits.
            for hit in scan.pending.drain(..) {
                let mut slot = Box::new(ResolveSlot {
                    service: std::ptr::null_mut(),
                    done: false,
                    result: None,
                });
                let err = unsafe {
                    DNSServiceResolve(
                        &mut slot.service,
                        0,
                        hit.interface_index,
                        hit.name.as_ptr(),
                        hit.regtype.as_ptr(),
                        hit.domain.as_ptr(),
                        resolve_reply,
                        (&mut *slot) as *mut ResolveSlot as *mut c_void,
                    )
                };
                if err == 0 {
                    slots.push(slot);
                }
            }

            // Poll the browse fd plus every unfinished resolve fd.
            let mut fds: Vec<libc::pollfd> = Vec::with_capacity(1 + slots.len());
            fds.push(libc::pollfd {
                fd: unsafe { DNSServiceRefSockFD(browse) },
                events: libc::POLLIN,
                revents: 0,
            });
            let live: Vec<usize> = slots
                .iter()
                .enumerate()
                .filter(|(_, s)| !s.done)
                .map(|(i, _)| i)
                .collect();
            for &i in &live {
                fds.push(libc::pollfd {
                    fd: unsafe { DNSServiceRefSockFD(slots[i].service) },
                    events: libc::POLLIN,
                    revents: 0,
                });
            }

            let millis = remaining.as_millis().min(250) as i32;
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, millis) };
            if ready < 0 {
                break;
            }
            if fds[0].revents & libc::POLLIN != 0 {
                unsafe { DNSServiceProcessResult(browse) };
            }
            for (pos, &i) in live.iter().enumerate() {
                if fds[pos + 1].revents & libc::POLLIN != 0 {
                    unsafe { DNSServiceProcessResult(slots[i].service) };
                }
            }
        }

        unsafe { DNSServiceRefDeallocate(browse) };
        let mut out: Vec<DiscoveredDesktop> = Vec::new();
        for slot in slots {
            unsafe { DNSServiceRefDeallocate(slot.service) };
            if let Some(desktop) = slot.result {
                // Dedupe by fingerprint — one desktop can resolve on
                // several interfaces.
                if !out.iter().any(|d| d.fingerprint == desktop.fingerprint) {
                    out.push(desktop);
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn txt_bytes(entries: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for e in entries {
            out.push(e.len() as u8);
            out.extend_from_slice(e.as_bytes());
        }
        out
    }

    #[test]
    fn parses_length_prefixed_txt_records() {
        let bytes = txt_bytes(&["name=halcyon", "version=0.11.2", "fingerprint=abc123"]);
        assert_eq!(
            parse_txt(&bytes),
            vec![
                ("name".into(), "halcyon".into()),
                ("version".into(), "0.11.2".into()),
                ("fingerprint".into(), "abc123".into()),
            ]
        );
    }

    #[test]
    fn txt_parse_skips_empty_and_survives_truncation() {
        let mut bytes = txt_bytes(&["name=x"]);
        bytes.insert(0, 0); // leading zero-length entry
        bytes.push(40); // truncated trailing entry
        bytes.extend_from_slice(b"short");
        assert_eq!(parse_txt(&bytes), vec![("name".into(), "x".into())]);
    }

    #[test]
    fn maps_resolved_service_with_name_fallback_and_dot_trim() {
        let txt = vec![
            ("fingerprint".to_string(), "ff".repeat(32)),
            ("version".to_string(), "1.0.0".to_string()),
        ];
        let desktop = desktop_from_resolved("halcyon.local.", 48213, &txt).unwrap();
        assert_eq!(desktop.hostname, "halcyon.local");
        assert_eq!(desktop.host, "halcyon.local:48213");
        assert_eq!(desktop.name, "halcyon"); // .local trimmed for the fallback
        assert_eq!(desktop.id, format!("remote:{}", "ff".repeat(32)));
    }

    #[test]
    fn drops_services_without_a_fingerprint() {
        let txt = vec![("name".to_string(), "imposter".to_string())];
        assert!(desktop_from_resolved("other.local.", 80, &txt).is_none());
    }
}
