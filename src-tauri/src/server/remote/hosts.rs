//! Outbound paired desktop hosts.
//!
//! `devices.rs` is the inbound auth store: clients that may connect to
//! this host. This file is the opposite direction: hosts this desktop may
//! connect to. It stores bearer tokens because Aethon must reconnect after
//! restart, so the file lives beside the TLS identity under the owner-only
//! `~/.aethon/remote/` directory and never crosses the frontend boundary.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::commands::host::HostInfo;
use crate::helpers::secure_files::write_owner_only;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedHostRecord {
    pub id: String,
    pub host_id: String,
    pub hostname: String,
    pub display_name: String,
    pub fingerprint: String,
    pub candidates: Vec<String>,
    pub token: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    #[serde(default)]
    pub alias: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedHostView {
    pub id: String,
    pub host_id: String,
    pub hostname: String,
    pub display_name: String,
    pub fingerprint: String,
    pub candidates: Vec<String>,
    pub created_at: i64,
    pub last_seen_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

impl From<&PairedHostRecord> for PairedHostView {
    fn from(record: &PairedHostRecord) -> Self {
        Self {
            id: record.id.clone(),
            host_id: record.host_id.clone(),
            hostname: record.hostname.clone(),
            display_name: record
                .alias
                .clone()
                .unwrap_or_else(|| record.display_name.clone()),
            fingerprint: record.fingerprint.clone(),
            candidates: record.candidates.clone(),
            created_at: record.created_at,
            last_seen_at: record.last_seen_at,
            alias: record.alias.clone(),
        }
    }
}

pub struct PairedHostStore {
    path: Option<PathBuf>,
    records: Mutex<Vec<PairedHostRecord>>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn host_id_for_fingerprint(fingerprint: &str) -> String {
    format!("remote:{fingerprint}")
}

impl PairedHostStore {
    pub fn load(dir: Option<PathBuf>) -> Self {
        let path = dir.map(|d| d.join("hosts.json"));
        let records = match &path {
            Some(p) if p.exists() => match std::fs::read_to_string(p)
                .map_err(|e| e.to_string())
                .and_then(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
            {
                Ok(records) => records,
                Err(e) => {
                    tracing::warn!(target: "aethon::server::remote", "remote hosts file unreadable, starting empty: {e}");
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

    fn persist(&self, records: &[PairedHostRecord]) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
        }
        let json = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
        write_owner_only(path, json.as_bytes())
    }

    pub fn upsert(
        &self,
        info: HostInfo,
        token: String,
        candidates: Vec<String>,
    ) -> Result<PairedHostView, String> {
        let now = now_ms();
        let id = host_id_for_fingerprint(&info.fingerprint);
        let mut records = self.records.lock().map_err(|e| e.to_string())?;
        let view = if let Some(existing) = records.iter_mut().find(|r| r.id == id) {
            existing.host_id = info.id;
            existing.hostname = info.hostname;
            existing.display_name = info.display_name;
            existing.fingerprint = info.fingerprint;
            existing.token = token;
            merge_candidates(&mut existing.candidates, candidates);
            existing.last_seen_at = now;
            PairedHostView::from(&*existing)
        } else {
            let record = PairedHostRecord {
                id,
                host_id: info.id,
                hostname: info.hostname,
                display_name: info.display_name,
                fingerprint: info.fingerprint,
                candidates: normalize_candidates(candidates),
                token,
                created_at: now,
                last_seen_at: now,
                alias: None,
            };
            let view = PairedHostView::from(&record);
            records.push(record);
            view
        };
        self.persist(&records)?;
        Ok(view)
    }

    pub fn list(&self) -> Vec<PairedHostView> {
        self.records
            .lock()
            .map(|records| records.iter().map(PairedHostView::from).collect())
            .unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<PairedHostRecord> {
        self.records
            .lock()
            .ok()?
            .iter()
            .find(|record| record.id == id)
            .cloned()
    }

    pub fn touch_candidates(&self, id: &str, candidates: Vec<String>) -> Result<(), String> {
        let mut records = self.records.lock().map_err(|e| e.to_string())?;
        let Some(record) = records.iter_mut().find(|r| r.id == id) else {
            return Ok(());
        };
        merge_candidates(&mut record.candidates, candidates);
        record.last_seen_at = now_ms();
        self.persist(&records)
    }

    pub fn forget(&self, id: &str) -> Result<(), String> {
        let mut records = self.records.lock().map_err(|e| e.to_string())?;
        let before = records.len();
        records.retain(|r| r.id != id);
        if records.len() == before {
            return Err(format!("unknown remote host {id}"));
        }
        self.persist(&records)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("host name must not be empty".to_string());
        }
        let mut records = self.records.lock().map_err(|e| e.to_string())?;
        let Some(record) = records.iter_mut().find(|r| r.id == id) else {
            return Err(format!("unknown remote host {id}"));
        };
        record.alias = Some(trimmed.to_string());
        self.persist(&records)
    }
}

fn normalize_candidates(candidates: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    merge_candidates(&mut out, candidates);
    out
}

fn merge_candidates(existing: &mut Vec<String>, candidates: Vec<String>) {
    for candidate in candidates {
        let trimmed = candidate.trim().trim_end_matches('/').to_string();
        if trimmed.is_empty() || existing.iter().any(|c| c == &trimmed) {
            continue;
        }
        existing.push(trimmed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(fp: &str) -> HostInfo {
        HostInfo {
            id: "local:test".into(),
            hostname: "bender.local".into(),
            display_name: "bender".into(),
            fingerprint: fp.into(),
        }
    }

    #[test]
    fn upsert_persists_token_without_exposing_it_in_view() {
        let dir = tempfile::tempdir().unwrap();
        let store = PairedHostStore::load(Some(dir.path().to_path_buf()));
        let view = store
            .upsert(
                info("f".repeat(64).as_str()),
                "tok-secret".into(),
                vec!["bender.local:1".into()],
            )
            .unwrap();
        assert_eq!(view.id, format!("remote:{}", "f".repeat(64)));
        let raw = std::fs::read_to_string(dir.path().join("hosts.json")).unwrap();
        assert!(raw.contains("tok-secret"));
        let serialized_view = serde_json::to_string(&view).unwrap();
        assert!(!serialized_view.contains("tok-secret"));
    }

    #[test]
    fn upsert_merges_candidates_by_fingerprint() {
        let store = PairedHostStore::load(None);
        let fp = "a".repeat(64);
        store
            .upsert(info(&fp), "tok-1".into(), vec!["bender.local:1".into()])
            .unwrap();
        store
            .upsert(info(&fp), "tok-2".into(), vec!["bender-2.local:1".into()])
            .unwrap();
        let rec = store.get(&host_id_for_fingerprint(&fp)).unwrap();
        assert_eq!(rec.token, "tok-2");
        assert_eq!(rec.candidates, vec!["bender.local:1", "bender-2.local:1"]);
    }
}
