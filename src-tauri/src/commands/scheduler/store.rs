use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use super::policy::{expire_due_tasks, now_ms, recover_loaded_running_tasks};
use super::types::ScheduledTaskRecord;
use super::{STORE_FILE, STORE_VERSION, TASK_VERSION};

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskStore {
    version: u8,
    tasks: Vec<ScheduledTaskRecord>,
}

#[derive(Default)]
pub(crate) struct SchedulerInner {
    pub(crate) tasks: HashMap<String, ScheduledTaskRecord>,
    storage_path: Option<PathBuf>,
    pub(crate) loaded: bool,
    pub(crate) live_tabs_known: bool,
    pub(crate) live_tab_ids: HashSet<String>,
}

pub struct ScheduledTasksState {
    inner: Mutex<SchedulerInner>,
    pub(crate) notify: Arc<Notify>,
}

impl ScheduledTasksState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SchedulerInner::default()),
            notify: Arc::new(Notify::new()),
        }
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, SchedulerInner> {
        self.inner.lock().unwrap_or_else(|poisoned| {
            tracing::warn!(target: "aethon::scheduler", "recovered poisoned scheduler state");
            poisoned.into_inner()
        })
    }
}

pub(super) fn task_list(state: &ScheduledTasksState) -> Vec<ScheduledTaskRecord> {
    let mut list: Vec<_> = state.lock().tasks.values().cloned().collect();
    list.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    list
}

pub(super) fn ensure_loaded(state: &ScheduledTasksState, app: &AppHandle) -> Result<(), String> {
    {
        let inner = state.lock();
        if inner.loaded {
            return Ok(());
        }
    }
    let path = storage_path(app)?;
    let mut tasks = read_store(&path)?;
    let recovered = recover_loaded_running_tasks(&mut tasks, now_ms());
    {
        let mut inner = state.lock();
        if inner.loaded {
            return Ok(());
        }
        inner.storage_path = Some(path.clone());
        inner.tasks = tasks;
        inner.loaded = true;
    }
    if recovered {
        persist_emit_notify(state, app)?;
    }
    Ok(())
}

pub(super) fn refresh_expired(state: &ScheduledTasksState, app: &AppHandle) -> Result<(), String> {
    let now = now_ms();
    let changed = {
        let mut inner = state.lock();
        expire_due_tasks(&mut inner.tasks, now)
    };
    if changed {
        persist_emit_notify(state, app)?;
    }
    Ok(())
}

pub(super) fn persist_emit_notify(
    state: &ScheduledTasksState,
    app: &AppHandle,
) -> Result<(), String> {
    persist_emit(state, app)?;
    state.notify.notify_waiters();
    Ok(())
}

pub(super) fn persist_emit(state: &ScheduledTasksState, app: &AppHandle) -> Result<(), String> {
    let list = task_list(state);
    let path = {
        let inner = state.lock();
        inner
            .storage_path
            .clone()
            .ok_or_else(|| "scheduled task store not initialized".to_string())?
    };
    write_store(&path, &list)?;
    let _ = app.emit("scheduled-tasks-changed", &list);
    Ok(())
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.join(STORE_FILE))
}

fn read_store(path: &Path) -> Result<HashMap<String, ScheduledTaskRecord>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let store: ScheduledTaskStore =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(store
        .tasks
        .into_iter()
        .filter(|task| task.version == TASK_VERSION)
        .map(|task| (task.id.clone(), task))
        .collect())
}

fn write_store(path: &Path, tasks: &[ScheduledTaskRecord]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let store = ScheduledTaskStore {
        version: STORE_VERSION,
        tasks: tasks.to_vec(),
    };
    let body = serde_json::to_string_pretty(&store).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::scheduler::{TASK_TTL_MS, types::*};

    fn test_task(now: i64, id: &str, version: u8) -> ScheduledTaskRecord {
        ScheduledTaskRecord {
            version,
            id: id.into(),
            tab_id: "tab".into(),
            cwd: "/tmp".into(),
            model: None,
            thinking_level: None,
            hard_enforce: None,
            auth_profile_id: None,
            label: "one".into(),
            prompt: "do it".into(),
            visible_prompt: "do it".into(),
            prompt_source: "inline".into(),
            mode: ScheduledTaskMode::OneShot,
            schedule: ScheduledTaskSchedule::OneShot { run_at: now },
            created_at: now - 1,
            updated_at: now - 1,
            next_run_at: Some(now),
            last_run_at: Some(now),
            last_completed_at: None,
            expires_at: now + TASK_TTL_MS,
            run_count: 1,
            coalesced_misses: 0,
            last_error: None,
            status: ScheduledTaskStatus::Scheduled,
            current_run_id: None,
        }
    }

    #[test]
    fn store_round_trips_current_schema_version() {
        let now = 1_700_000_000_000;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("scheduled-tasks.json");
        let task = test_task(now, "task", TASK_VERSION);

        write_store(&path, std::slice::from_ref(&task)).unwrap();
        let loaded = read_store(&path).unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded.get("task").unwrap().id, task.id);
        assert_eq!(loaded.get("task").unwrap().version, TASK_VERSION);
    }

    #[test]
    fn read_store_skips_unknown_task_versions() {
        let now = 1_700_000_000_000;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("scheduled-tasks.json");
        let current = test_task(now, "current", TASK_VERSION);
        let future = test_task(now, "future", TASK_VERSION + 1);

        write_store(&path, &[current, future]).unwrap();
        let loaded = read_store(&path).unwrap();

        assert_eq!(loaded.len(), 1);
        assert!(loaded.contains_key("current"));
        assert!(!loaded.contains_key("future"));
    }
}
