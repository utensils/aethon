//! TLS identity for the remote gateway.
//!
//! A self-signed certificate persisted at `~/.aethon/remote/{cert,key}.pem`
//! (dir 0700, files 0600). Paired clients don't verify a chain — they pin
//! the certificate by its SHA-256 DER fingerprint, exchanged out-of-band
//! during pairing (QR / PIN screen). That fingerprint is also what
//! `host_info` and the mDNS TXT record now carry, replacing the
//! placeholder the scaffold shipped with.
//!
//! The identity is process-wide and created lazily on first use. Creation
//! failures degrade to `None` — callers fall back to the placeholder
//! fingerprint and the plain-HTTP scaffold behaviour rather than blocking
//! boot on a disk error.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use crate::helpers::secure_files::{set_dir_owner_only, write_owner_only};

pub struct TlsIdentity {
    pub cert_pem: String,
    pub key_pem: String,
    /// Lowercase hex SHA-256 of the DER certificate — the value clients pin.
    pub fingerprint: String,
}

static IDENTITY: OnceLock<Option<TlsIdentity>> = OnceLock::new();

/// The process-wide identity, created on first use.
pub fn identity() -> Option<&'static TlsIdentity> {
    IDENTITY
        .get_or_init(|| {
            let Some(dir) = default_remote_dir() else {
                tracing::warn!(target: "aethon::server::tls", "no user dir; TLS identity unavailable");
                return None;
            };
            match load_or_create(&dir) {
                Ok(identity) => Some(identity),
                Err(e) => {
                    tracing::warn!(target: "aethon::server::tls", "TLS identity unavailable: {e}");
                    None
                }
            }
        })
        .as_ref()
}

/// Make the ring `CryptoProvider` the process default. rustls 0.23 needs
/// one installed before any `ServerConfig` is built; ring (not aws-lc-rs)
/// keeps us on the provider reqwest already links. Idempotent — a lost
/// race just means another caller installed the same provider.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// `~/.aethon/remote/` — shared home of the TLS identity and the
/// paired-device store.
pub(crate) fn default_remote_dir() -> Option<PathBuf> {
    crate::helpers::aethon_dir(std::env::home_dir()).map(|d| d.join("remote"))
}

/// Load the persisted identity or generate + persist a fresh one.
/// Exposed with an explicit dir for tests; production goes through
/// [`identity`].
pub fn load_or_create(dir: &Path) -> Result<TlsIdentity, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    set_dir_owner_only(dir)?;
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");

    if cert_path.exists() && key_path.exists() {
        let cert_pem = std::fs::read_to_string(&cert_path)
            .map_err(|e| format!("read {}: {e}", cert_path.display()))?;
        let key_pem = std::fs::read_to_string(&key_path)
            .map_err(|e| format!("read {}: {e}", key_path.display()))?;
        let der = pem_certificate_der(&cert_pem)
            .ok_or_else(|| format!("{}: no CERTIFICATE block", cert_path.display()))?;
        return Ok(TlsIdentity {
            cert_pem,
            key_pem,
            fingerprint: sha256_hex(&der),
        });
    }

    let hostname = gethostname::gethostname().to_string_lossy().into_owned();
    let certified = rcgen::generate_simple_self_signed(vec![hostname, "localhost".to_string()])
        .map_err(|e| format!("generate cert: {e}"))?;
    let cert_pem = certified.cert.pem();
    let key_pem = certified.signing_key.serialize_pem();
    // Key first: if the second write fails we're left with an unreadable
    // half-identity that the next boot's exists() check regenerates.
    write_owner_only(&key_path, key_pem.as_bytes())?;
    write_owner_only(&cert_path, cert_pem.as_bytes())?;
    Ok(TlsIdentity {
        fingerprint: sha256_hex(certified.cert.der().as_ref()),
        cert_pem,
        key_pem,
    })
}

/// Extract the DER bytes of the first CERTIFICATE block in a PEM file.
fn pem_certificate_der(pem: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let mut b64 = String::new();
    let mut inside = false;
    for line in pem.lines() {
        let line = line.trim();
        if line == "-----BEGIN CERTIFICATE-----" {
            inside = true;
            continue;
        }
        if line == "-----END CERTIFICATE-----" {
            break;
        }
        if inside {
            b64.push_str(line);
        }
    }
    if b64.is_empty() {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_identity_with_pinned_shape() {
        let dir = tempfile::tempdir().unwrap();
        let identity = load_or_create(dir.path()).unwrap();
        assert_eq!(identity.fingerprint.len(), 64);
        assert!(identity.fingerprint.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(identity.cert_pem.contains("BEGIN CERTIFICATE"));
        assert!(identity.key_pem.contains("PRIVATE KEY"));
        assert!(dir.path().join("cert.pem").exists());
        assert!(dir.path().join("key.pem").exists());
    }

    #[test]
    fn fingerprint_is_stable_across_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create(dir.path()).unwrap();
        let second = load_or_create(dir.path()).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.cert_pem, second.cert_pem);
    }

    #[test]
    fn corrupt_cert_pem_is_an_error_not_a_silent_regen() {
        let dir = tempfile::tempdir().unwrap();
        load_or_create(dir.path()).unwrap();
        std::fs::write(dir.path().join("cert.pem"), "garbage").unwrap();
        // `.err()` rather than `unwrap_err()`: TlsIdentity deliberately
        // has no Debug impl so key material can't reach logs.
        let err = load_or_create(dir.path()).err().expect("must fail");
        assert!(err.contains("no CERTIFICATE block"), "got: {err}");
    }

    #[test]
    fn pem_der_roundtrip_matches_rcgen_der() {
        let certified =
            rcgen::generate_simple_self_signed(vec!["test.local".to_string()]).unwrap();
        let der = pem_certificate_der(&certified.cert.pem()).unwrap();
        assert_eq!(der, certified.cert.der().as_ref());
    }

    #[cfg(unix)]
    #[test]
    fn key_material_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create(dir.path()).unwrap();
        for name in ["key.pem", "cert.pem"] {
            let mode = std::fs::metadata(dir.path().join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode & 0o077, 0, "{name} mode {mode:o} leaks beyond owner");
        }
    }
}
