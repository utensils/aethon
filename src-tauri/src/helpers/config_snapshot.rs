//! Shared, mtime-invalidated view of `config.toml`.
//!
//! Boot, server, agent spawning, and devshell probes previously each read and
//! parsed the same file independently. This cache keeps one normalized JSON
//! snapshot per path while still noticing external editor writes.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Clone)]
pub struct ConfigSnapshot {
    pub raw: String,
    pub parsed: serde_json::Value,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Fingerprint {
    modified: Option<SystemTime>,
    len: u64,
}

#[derive(Clone)]
struct CachedSnapshot {
    fingerprint: Option<Fingerprint>,
    snapshot: ConfigSnapshot,
}

static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedSnapshot>>> = OnceLock::new();
const CONFIG_READ_LIMIT_BYTES: u64 = 64 * 1024;

fn cache() -> &'static Mutex<HashMap<PathBuf, CachedSnapshot>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn fingerprint(path: &Path) -> Option<Fingerprint> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(Fingerprint {
        modified: metadata.modified().ok(),
        len: metadata.len(),
    })
}

pub fn read_config_snapshot(path: &Path) -> ConfigSnapshot {
    let current = fingerprint(path);
    {
        let snapshots = cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cached) = snapshots.get(path)
            && cached.fingerprint == current
        {
            return cached.snapshot.clone();
        }
    }

    let mut raw = String::new();
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.take(CONFIG_READ_LIMIT_BYTES).read_to_string(&mut raw);
    }
    let snapshot = ConfigSnapshot {
        parsed: super::parse_config_toml(&raw),
        raw,
    };
    let mut snapshots = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    snapshots.insert(
        path.to_path_buf(),
        CachedSnapshot {
            fingerprint: current,
            snapshot: snapshot.clone(),
        },
    );
    snapshot
}

/// Invalidate after an in-process writer replaces `config.toml`. External
/// writes are detected by the fingerprint automatically.
pub fn invalidate_config_snapshot(path: &Path) {
    cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reuses_and_refreshes_normalized_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[server]\nenabled = false\n").unwrap();
        let first = read_config_snapshot(&path);
        assert_eq!(first.parsed["server"]["enabled"], false);

        std::fs::write(&path, "[server]\nenabled = true\nport = 4040\n").unwrap();
        let refreshed = read_config_snapshot(&path);
        assert_eq!(refreshed.parsed["server"]["enabled"], true);
        assert_eq!(refreshed.parsed["server"]["port"], 4040);
    }

    #[test]
    fn explicit_invalidation_observes_same_fingerprint_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[server]\nport = 1000\n").unwrap();
        let _ = read_config_snapshot(&path);
        std::fs::write(&path, "[server]\nport = 2000\n").unwrap();
        invalidate_config_snapshot(&path);
        assert_eq!(read_config_snapshot(&path).parsed["server"]["port"], 2000);
    }

    #[test]
    fn snapshot_caps_runaway_config_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut content = " ".repeat(CONFIG_READ_LIMIT_BYTES as usize);
        content.push_str("\n[server]\nenabled = false\n");
        std::fs::write(&path, content).unwrap();

        let snapshot = read_config_snapshot(&path);

        assert_eq!(snapshot.raw.len(), CONFIG_READ_LIMIT_BYTES as usize);
        assert_eq!(snapshot.parsed["server"]["enabled"], true);
    }
}
