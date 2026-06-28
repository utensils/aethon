//! File I/O for the persisted window-state store. Resolves the path
//! under `~/.aethon/` (honoring the dev-sandbox override that
//! `helpers::aethon_dir` provides) and reads/writes JSON with migration
//! applied on load.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use super::migration::migrate;
use super::schema::PersistedStore;

const STATE_FILE: &str = "window-state.json";

fn state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.join(STATE_FILE))
}

pub(super) fn load_store(app: &AppHandle) -> PersistedStore {
    if let Ok(Some(s)) = crate::storage::read_state_value(app, STATE_FILE)
        && !s.trim().is_empty()
    {
        let raw: PersistedStore = serde_json::from_str(&s).unwrap_or_else(|e| {
            tracing::warn!(target: "aethon::window_state", "parse sqlite {STATE_FILE}: {e}");
            PersistedStore::default()
        });
        return migrate(raw);
    }
    let Ok(path) = state_file_path(app) else {
        return PersistedStore::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => {
            let raw: PersistedStore = serde_json::from_str(&s).unwrap_or_else(|e| {
                tracing::warn!(target: "aethon::window_state", "parse {}: {e}", path.display());
                PersistedStore::default()
            });
            migrate(raw)
        }
        _ => PersistedStore::default(),
    }
}

pub(super) fn save_store(app: &AppHandle, store: &PersistedStore) -> Result<(), String> {
    let body = serde_json::to_string_pretty(store).map_err(|e| format!("serialize: {e}"))?;
    crate::storage::write_state_value(app, STATE_FILE, &body).or_else(|err| {
        tracing::warn!(target: "aethon::window_state", "sqlite write failed: {err}; writing legacy file");
        let path = state_file_path(app)?;
        std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::super::schema::{CURRENT_VERSION, PersistedStore};
    use super::super::test_support::{approx_eq, mon, state};

    #[test]
    fn persisted_store_round_trips_through_json() {
        let mut store = PersistedStore::default();
        store.states.insert(
            "main".into(),
            state(
                100.0,
                200.0,
                800.0,
                600.0,
                mon(0.0, 0.0, 1920.0, 1080.0, 1.0),
            ),
        );
        let back: PersistedStore =
            serde_json::from_str(&serde_json::to_string(&store).unwrap()).unwrap();
        let r = back.states.get("main").unwrap();
        assert!(approx_eq(r.x, 100.0) && approx_eq(r.width, 800.0));
        assert!(approx_eq(r.monitor.scale, 1.0));
        assert_eq!(r.version, CURRENT_VERSION);
    }
}
