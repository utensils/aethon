//! Native scheduled tasks and `/loop` support.
//!
//! The scheduler is Rust-owned because per-tab agent workers are disposable:
//! a tab worker may retire while its tab still exists, so timers cannot live
//! inside the bridge process. React reports the currently restored/live tabs;
//! only then do tasks arm and dispatch chat payloads through the normal agent
//! supervisor path.

use std::collections::HashSet;

use tauri::{AppHandle, State};

mod cron;
mod loop_prompt;
mod policy;
mod runner;
mod store;
mod types;

pub use store::ScheduledTasksState;
pub(crate) use types::{
    LoopPromptResolution, ScheduledTaskCompleteInput, ScheduledTaskCreate, ScheduledTaskRecord,
    ScheduledTaskTabFailureInput, ScheduledTaskUpdate, ScheduledTaskWakeupInput,
};

const STORE_FILE: &str = "scheduled-tasks.json";
const STORE_VERSION: u8 = 1;
const TASK_VERSION: u8 = 1;
const TASK_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS: u64 = 60 * 1000;
const MAX_DELAY_MS: u64 = TASK_TTL_MS as u64;
const IDLE_RETRY_MS: i64 = 10 * 1000;
const MAX_FIRES_PER_TICK: usize = 3;
const LOOP_PROMPT_MAX_BYTES: usize = 25_000;

pub(crate) fn boot(app: AppHandle) {
    runner::boot(app);
}

#[tauri::command]
pub(crate) fn scheduled_tasks_list(
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<Vec<ScheduledTaskRecord>, String> {
    store::ensure_loaded(&state, &app)?;
    store::refresh_expired(&state, &app)?;
    Ok(store::task_list(&state))
}

#[tauri::command]
pub(crate) fn scheduled_tasks_reconcile_live_tabs(
    live_tab_ids: Vec<String>,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<Vec<ScheduledTaskRecord>, String> {
    store::ensure_loaded(&state, &app)?;
    let live: HashSet<String> = live_tab_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty())
        .collect();
    {
        let mut inner = state.lock();
        inner.live_tabs_known = true;
        inner.live_tab_ids = live;
        let now = policy::now_ms();
        let live_tab_ids = inner.live_tab_ids.clone();
        policy::reconcile_live_tabs(&mut inner.tasks, &live_tab_ids, now);
    }
    store::persist_emit_notify(&state, &app)?;
    Ok(store::task_list(&state))
}

#[tauri::command]
pub(crate) fn scheduled_tasks_fail_running_for_tab(
    input: ScheduledTaskTabFailureInput,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<Vec<ScheduledTaskRecord>, String> {
    store::ensure_loaded(&state, &app)?;
    let now = policy::now_ms();
    let reason = input
        .message
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("agent worker crashed before scheduled run completed")
        .to_string();
    let tab_id = input
        .tab_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let changed = {
        let mut inner = state.lock();
        policy::fail_running_tasks_for_tab(&mut inner.tasks, tab_id, now, &reason, IDLE_RETRY_MS)
    };
    if changed {
        store::persist_emit_notify(&state, &app)?;
    }
    Ok(store::task_list(&state))
}

#[tauri::command]
pub(crate) fn scheduled_task_create(
    input: ScheduledTaskCreate,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    store::ensure_loaded(&state, &app)?;
    let now = policy::now_ms();
    let expires_at = now.saturating_add(TASK_TTL_MS);
    let prompt = input.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("prompt required".to_string());
    }
    let tab_id = input.tab_id.trim().to_string();
    if tab_id.is_empty() {
        return Err("tabId required".to_string());
    }
    let cwd = input.cwd.trim().to_string();
    if cwd.is_empty() {
        return Err("cwd required".to_string());
    }
    let schedule = policy::normalize_schedule(input.schedule, now, expires_at)?;
    let mode = input
        .mode
        .unwrap_or_else(|| policy::mode_for_schedule(&schedule));
    policy::validate_mode_schedule(mode, &schedule)?;
    let next_run_at = policy::initial_next_run_at(&schedule, now, expires_at)?;
    let label = input
        .label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| policy::label_from_prompt(&prompt));
    let record = ScheduledTaskRecord {
        version: TASK_VERSION,
        id: uuid::Uuid::new_v4().simple().to_string(),
        tab_id,
        cwd,
        model: policy::non_empty(input.model),
        thinking_level: policy::non_empty(input.thinking_level),
        hard_enforce: input.hard_enforce,
        auth_profile_id: policy::non_empty(input.auth_profile_id),
        label,
        visible_prompt: input
            .visible_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(prompt.as_str())
            .to_string(),
        prompt,
        prompt_source: input
            .prompt_source
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("inline")
            .to_string(),
        mode,
        schedule,
        created_at: now,
        updated_at: now,
        next_run_at,
        last_run_at: None,
        last_completed_at: None,
        expires_at,
        run_count: 0,
        coalesced_misses: 0,
        last_error: None,
        status: types::ScheduledTaskStatus::Scheduled,
        current_run_id: None,
    };
    {
        let mut inner = state.lock();
        inner.tasks.insert(record.id.clone(), record.clone());
    }
    store::persist_emit_notify(&state, &app)?;
    Ok(record)
}

#[tauri::command]
pub(crate) fn scheduled_task_update(
    id: String,
    patch: ScheduledTaskUpdate,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    store::ensure_loaded(&state, &app)?;
    let now = policy::now_ms();
    let updated = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get_mut(&id)
            .ok_or_else(|| format!("unknown task: {id}"))?;
        if matches!(task.status, types::ScheduledTaskStatus::Running) {
            return Err("cannot edit a running task".to_string());
        }
        if let Some(label) = patch.label.as_deref().map(str::trim)
            && !label.is_empty()
        {
            task.label = label.to_string();
        }
        if let Some(prompt) = patch.prompt.as_deref().map(str::trim)
            && !prompt.is_empty()
        {
            task.prompt = prompt.to_string();
            task.visible_prompt = patch
                .visible_prompt
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(prompt)
                .to_string();
        }
        if let Some(schedule) = patch.schedule {
            let normalized = policy::normalize_schedule(schedule, now, task.expires_at)?;
            policy::validate_mode_schedule(task.mode, &normalized)?;
            task.next_run_at = policy::initial_next_run_at(&normalized, now, task.expires_at)?;
            task.schedule = normalized;
            if !task.status.terminal() {
                task.status = types::ScheduledTaskStatus::Scheduled;
            }
        }
        task.updated_at = now;
        task.last_error = None;
        task.clone()
    };
    store::persist_emit_notify(&state, &app)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn scheduled_task_pause(
    id: String,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    set_status(id, types::ScheduledTaskStatus::Paused, state, app)
}

#[tauri::command]
pub(crate) fn scheduled_task_resume(
    id: String,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    store::ensure_loaded(&state, &app)?;
    let now = policy::now_ms();
    let updated = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get_mut(&id)
            .ok_or_else(|| format!("unknown task: {id}"))?;
        if task.status == types::ScheduledTaskStatus::Running {
            return Err("task is already running".to_string());
        }
        policy::resume_task_record(task, now)?;
        task.updated_at = now;
        task.clone()
    };
    store::persist_emit_notify(&state, &app)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn scheduled_task_cancel(
    id: String,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    set_status(id, types::ScheduledTaskStatus::Cancelled, state, app)
}

#[tauri::command]
pub(crate) fn scheduled_task_delete(
    id: String,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    store::ensure_loaded(&state, &app)?;
    let removed = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get(&id)
            .ok_or_else(|| format!("unknown task: {id}"))?;
        if task.status == types::ScheduledTaskStatus::Running {
            return Err("cannot delete a running task; stop or wait for completion".to_string());
        }
        inner
            .tasks
            .remove(&id)
            .ok_or_else(|| format!("unknown task: {id}"))?
    };
    store::persist_emit_notify(&state, &app)?;
    Ok(removed)
}

#[tauri::command]
pub(crate) async fn scheduled_task_run_now(
    id: String,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    store::ensure_loaded(&state, &app)?;
    runner::start_task_run(&app, &state, &id, true).await
}

#[tauri::command]
pub(crate) fn scheduled_task_schedule_wakeup(
    input: ScheduledTaskWakeupInput,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    store::ensure_loaded(&state, &app)?;
    let now = policy::now_ms();
    let next = match (input.next_run_at, input.delay_ms) {
        (Some(at), _) => at,
        (None, Some(delay)) => now.saturating_add(delay.min(MAX_DELAY_MS) as i64),
        (None, None) => return Err("nextRunAt or delayMs required".to_string()),
    };
    let updated = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get_mut(&input.task_id)
            .ok_or_else(|| format!("unknown task: {}", input.task_id))?;
        if task.mode != types::ScheduledTaskMode::LoopSelfPaced {
            return Err("only self-paced loop tasks accept wakeups".to_string());
        }
        if let Some(run_id) = input.run_id.as_deref()
            && task.current_run_id.as_deref() != Some(run_id)
        {
            return Err("wakeup runId does not match current run".to_string());
        }
        if next <= now {
            return Err("next wakeup must be in the future".to_string());
        }
        if next > task.expires_at {
            return Err("next wakeup exceeds the task's 7-day lifetime".to_string());
        }
        task.schedule = types::ScheduledTaskSchedule::SelfPaced {
            next_run_at: Some(next),
            reason: policy::non_empty(input.reason),
        };
        task.next_run_at = Some(next);
        task.last_error = None;
        task.updated_at = now;
        task.clone()
    };
    store::persist_emit_notify(&state, &app)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn scheduled_task_complete(
    input: ScheduledTaskCompleteInput,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    store::ensure_loaded(&state, &app)?;
    let now = policy::now_ms();
    let updated = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get_mut(&input.task_id)
            .ok_or_else(|| format!("unknown task: {}", input.task_id))?;
        if task.current_run_id.as_deref() != Some(input.run_id.as_str()) {
            return Err("completion runId does not match current run".to_string());
        }
        task.last_completed_at = Some(now);
        task.current_run_id = None;
        task.updated_at = now;
        if !input.success {
            task.status = types::ScheduledTaskStatus::Failed;
            task.next_run_at = None;
            task.last_error =
                policy::non_empty(input.error).or_else(|| Some("scheduled run failed".to_string()));
        } else {
            task.last_error = None;
            policy::complete_success(task, now, input.complete_task == Some(true))?;
        }
        task.clone()
    };
    store::persist_emit_notify(&state, &app)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn scheduled_task_resolve_loop_prompt(
    cwd: Option<String>,
    app: AppHandle,
) -> Result<LoopPromptResolution, String> {
    loop_prompt::resolve_loop_prompt(cwd.as_deref(), &app)
}

fn set_status(
    id: String,
    status: types::ScheduledTaskStatus,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    store::ensure_loaded(&state, &app)?;
    let now = policy::now_ms();
    let updated = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get_mut(&id)
            .ok_or_else(|| format!("unknown task: {id}"))?;
        policy::set_status_record(task, status, now)?;
        task.clone()
    };
    store::persist_emit_notify(&state, &app)?;
    Ok(updated)
}
