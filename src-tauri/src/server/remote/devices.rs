//! Paired-device store at `~/.aethon/remote/devices.json` (0600).
//!
//! Only `sha256(token)` is persisted — the plaintext device token is
//! shown to the phone exactly once at pairing time. Verification hashes
//! the presented token and compares constant-time against non-revoked
//! records. Small N (a handful of personal devices), so a flat JSON
//! file mirrors the `control/` precedent and stays inspectable.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::helpers::secure_files::write_owner_only;
use crate::server::tls::sha256_hex;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub token_sha256: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    #[serde(default)]
    pub revoked: bool,
}

/// What the Settings device list sees — everything except the token hash.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub revoked: bool,
}

impl From<&DeviceRecord> for DeviceView {
    fn from(r: &DeviceRecord) -> Self {
        DeviceView {
            id: r.id.clone(),
            name: r.name.clone(),
            platform: r.platform.clone(),
            created_at: r.created_at,
            last_seen_at: r.last_seen_at,
            revoked: r.revoked,
        }
    }
}

pub struct DeviceStore {
    /// `None` → in-memory only (no resolvable user dir; also what most
    /// unit tests use). Pairing still works for the session but devices
    /// won't survive a restart — the pairing UI surfaces the warning.
    path: Option<PathBuf>,
    records: Mutex<Vec<DeviceRecord>>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Bitwise constant-time equality; both operands are hex digests of
/// equal length in the non-error path, and length mismatch fails fast
/// without revealing anything the length didn't already.
pub(crate) fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

impl DeviceStore {
    /// Load from `<dir>/devices.json`; a missing or unparsable file is
    /// an empty store (unparsable also logs — losing paired devices
    /// should be loud).
    pub fn load(dir: Option<PathBuf>) -> Self {
        let path = dir.map(|d| d.join("devices.json"));
        let records = match &path {
            Some(p) if p.exists() => match std::fs::read_to_string(p)
                .map_err(|e| e.to_string())
                .and_then(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
            {
                Ok(records) => records,
                Err(e) => {
                    tracing::warn!(target: "aethon::server::remote", "devices.json unreadable, starting empty: {e}");
                    Vec::new()
                }
            },
            _ => Vec::new(),
        };
        Self {
            path,
            records: Mutex::new(records),
        }
    }

    fn persist(&self, records: &[DeviceRecord]) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
        }
        let json = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
        write_owner_only(path, json.as_bytes())
    }

    /// Register a freshly paired device. The caller generated `token`
    /// and hands it to the device; only the hash is stored.
    pub fn add(&self, name: &str, platform: &str, token: &str) -> Result<DeviceView, String> {
        let now = now_ms();
        let record = DeviceRecord {
            id: format!("dev-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
            name: name.to_string(),
            platform: platform.to_string(),
            token_sha256: sha256_hex(token.as_bytes()),
            created_at: now,
            last_seen_at: now,
            revoked: false,
        };
        let mut records = self.records.lock().map_err(|e| e.to_string())?;
        records.push(record.clone());
        self.persist(&records)?;
        Ok(DeviceView::from(&record))
    }

    /// Resolve a presented token to its non-revoked device. Scans every
    /// record without early exit — `find` would leak, via wall-clock,
    /// which record matched, undoing the constant-time compare. N is
    /// tiny, so the full scan is free.
    pub fn verify_token(&self, token: &str) -> Option<DeviceView> {
        let hash = sha256_hex(token.as_bytes());
        let records = self.records.lock().ok()?;
        let mut matched: Option<&DeviceRecord> = None;
        for record in records.iter() {
            let hit = !record.revoked && constant_time_eq(&record.token_sha256, &hash);
            if hit {
                matched = Some(record);
            }
        }
        matched.map(DeviceView::from)
    }

    /// Record activity from a device (connect / reconnect).
    pub fn touch(&self, id: &str) {
        let Ok(mut records) = self.records.lock() else {
            return;
        };
        if let Some(r) = records.iter_mut().find(|r| r.id == id) {
            r.last_seen_at = now_ms();
            let snapshot = records.clone();
            let _ = self.persist(&snapshot);
        }
    }

    pub fn list(&self) -> Vec<DeviceView> {
        self.records
            .lock()
            .map(|records| records.iter().map(DeviceView::from).collect())
            .unwrap_or_default()
    }

    /// Revocation keeps the record (audit trail + tombstone) but the
    /// token stops verifying immediately; the WS layer also closes any
    /// live connection for the id.
    pub fn revoke(&self, id: &str) -> Result<(), String> {
        self.mutate(id, |r| r.revoked = true)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("device name must not be empty".to_string());
        }
        self.mutate(id, |r| r.name = name.to_string())
    }

    fn mutate(&self, id: &str, f: impl FnOnce(&mut DeviceRecord)) -> Result<(), String> {
        let mut records = self.records.lock().map_err(|e| e.to_string())?;
        let Some(record) = records.iter_mut().find(|r| r.id == id) else {
            return Err(format!("unknown device {id}"));
        };
        f(record);
        self.persist(&records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &tempfile::TempDir) -> DeviceStore {
        DeviceStore::load(Some(dir.path().to_path_buf()))
    }

    #[test]
    fn add_then_verify_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(&dir);
        let added = s.add("James's iPhone", "ios", "tok-abc").unwrap();
        let found = s.verify_token("tok-abc").expect("token must verify");
        assert_eq!(found.id, added.id);
        assert!(s.verify_token("tok-abd").is_none(), "near-miss token");
        assert!(s.verify_token("").is_none());
    }

    #[test]
    fn revoked_device_stops_verifying_but_stays_listed() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(&dir);
        let added = s.add("iPad", "ios", "tok-1").unwrap();
        s.revoke(&added.id).unwrap();
        assert!(s.verify_token("tok-1").is_none());
        let listed = s.list();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].revoked);
    }

    #[test]
    fn store_persists_across_reload() {
        let dir = tempfile::tempdir().unwrap();
        {
            let s = store(&dir);
            s.add("Phone", "ios", "tok-persist").unwrap();
        }
        let reloaded = store(&dir);
        assert!(reloaded.verify_token("tok-persist").is_some());
        assert_eq!(reloaded.list().len(), 1);
    }

    #[test]
    fn persisted_file_never_contains_the_token() {
        let dir = tempfile::tempdir().unwrap();
        store(&dir).add("Phone", "ios", "tok-secret").unwrap();
        let raw = std::fs::read_to_string(dir.path().join("devices.json")).unwrap();
        assert!(!raw.contains("tok-secret"));
        assert!(raw.contains("tokenSha256"));
    }

    #[test]
    fn rename_validates_and_applies() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(&dir);
        let added = s.add("Phone", "ios", "t").unwrap();
        assert!(s.rename(&added.id, "  ").is_err());
        s.rename(&added.id, "Renamed").unwrap();
        assert_eq!(s.list()[0].name, "Renamed");
        assert!(s.rename("dev-missing", "x").is_err());
    }

    #[test]
    fn constant_time_eq_semantics() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn memory_only_store_works_without_dir() {
        let s = DeviceStore::load(None);
        s.add("Phone", "ios", "tok").unwrap();
        assert!(s.verify_token("tok").is_some());
    }
}
