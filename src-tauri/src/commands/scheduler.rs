//! Native scheduled tasks and `/loop` support.
//!
//! The scheduler is Rust-owned because per-tab agent workers are disposable:
//! a tab worker may retire while its tab still exists, so timers cannot live
//! inside the bridge process. React reports the currently restored/live tabs;
//! only then do tasks arm and dispatch chat payloads through the normal agent
//! supervisor path.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use chrono::{Datelike, Local, TimeZone, Timelike};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use crate::agent_process::{AgentProcesses, lock_recover, prompt_wedged, tab_agent_key};

const STORE_FILE: &str = "scheduled-tasks.json";
const STORE_VERSION: u8 = 1;
const TASK_VERSION: u8 = 1;
const TASK_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS: u64 = 60 * 1000;
const MAX_DELAY_MS: u64 = TASK_TTL_MS as u64;
const IDLE_RETRY_MS: i64 = 10 * 1000;
const MAX_FIRES_PER_TICK: usize = 3;
const LOOP_PROMPT_MAX_BYTES: usize = 25_000;

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScheduledTaskMode {
    LoopFixed,
    LoopSelfPaced,
    OneShot,
    Cron,
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScheduledTaskStatus {
    Scheduled,
    Running,
    Paused,
    Expired,
    Cancelled,
    Failed,
    Completed,
}

impl ScheduledTaskStatus {
    fn terminal(self) -> bool {
        matches!(
            self,
            ScheduledTaskStatus::Expired
                | ScheduledTaskStatus::Cancelled
                | ScheduledTaskStatus::Completed
        )
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScheduledTaskSchedule {
    Interval {
        #[serde(rename = "intervalMs")]
        interval_ms: u64,
        label: String,
    },
    SelfPaced {
        #[serde(rename = "nextRunAt")]
        next_run_at: Option<i64>,
        reason: Option<String>,
    },
    OneShot {
        #[serde(rename = "runAt")]
        run_at: i64,
    },
    Cron {
        expression: String,
    },
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskRecord {
    version: u8,
    id: String,
    tab_id: String,
    cwd: String,
    model: Option<String>,
    thinking_level: Option<String>,
    hard_enforce: Option<bool>,
    auth_profile_id: Option<String>,
    label: String,
    prompt: String,
    visible_prompt: String,
    prompt_source: String,
    mode: ScheduledTaskMode,
    schedule: ScheduledTaskSchedule,
    created_at: i64,
    updated_at: i64,
    next_run_at: Option<i64>,
    last_run_at: Option<i64>,
    last_completed_at: Option<i64>,
    expires_at: i64,
    run_count: u32,
    coalesced_misses: u32,
    last_error: Option<String>,
    status: ScheduledTaskStatus,
    current_run_id: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskCreate {
    tab_id: String,
    cwd: String,
    model: Option<String>,
    thinking_level: Option<String>,
    hard_enforce: Option<bool>,
    auth_profile_id: Option<String>,
    label: Option<String>,
    prompt: String,
    visible_prompt: Option<String>,
    prompt_source: Option<String>,
    mode: Option<ScheduledTaskMode>,
    schedule: ScheduledTaskSchedule,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskUpdate {
    label: Option<String>,
    prompt: Option<String>,
    visible_prompt: Option<String>,
    schedule: Option<ScheduledTaskSchedule>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskCompleteInput {
    task_id: String,
    run_id: String,
    success: bool,
    error: Option<String>,
    complete_task: Option<bool>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskWakeupInput {
    task_id: String,
    run_id: Option<String>,
    next_run_at: Option<i64>,
    delay_ms: Option<u64>,
    reason: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskTabFailureInput {
    tab_id: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopPromptResolution {
    prompt: String,
    source: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskFired {
    task: ScheduledTaskRecord,
    run_id: String,
    visible_prompt: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskError {
    task_id: String,
    run_id: Option<String>,
    message: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskStore {
    version: u8,
    tasks: Vec<ScheduledTaskRecord>,
}

#[derive(Default)]
struct SchedulerInner {
    tasks: HashMap<String, ScheduledTaskRecord>,
    storage_path: Option<PathBuf>,
    loaded: bool,
    live_tabs_known: bool,
    live_tab_ids: HashSet<String>,
}

pub struct ScheduledTasksState {
    inner: Mutex<SchedulerInner>,
    notify: Arc<Notify>,
}

impl ScheduledTasksState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SchedulerInner::default()),
            notify: Arc::new(Notify::new()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, SchedulerInner> {
        self.inner.lock().unwrap_or_else(|poisoned| {
            tracing::warn!(target: "aethon::scheduler", "recovered poisoned scheduler state");
            poisoned.into_inner()
        })
    }
}

pub(crate) fn boot(app: AppHandle) {
    let state = app.state::<ScheduledTasksState>();
    if let Err(err) = ensure_loaded(&state, &app) {
        tracing::warn!(target: "aethon::scheduler", "scheduled task boot load failed: {err}");
    }
    let notify = state.notify.clone();
    tauri::async_runtime::spawn(async move {
        scheduler_loop(app, notify).await;
    });
}

#[tauri::command]
pub(crate) fn scheduled_tasks_list(
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<Vec<ScheduledTaskRecord>, String> {
    ensure_loaded(&state, &app)?;
    refresh_expired(&state, &app)?;
    Ok(task_list(&state))
}

#[tauri::command]
pub(crate) fn scheduled_tasks_reconcile_live_tabs(
    live_tab_ids: Vec<String>,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<Vec<ScheduledTaskRecord>, String> {
    ensure_loaded(&state, &app)?;
    let live: HashSet<String> = live_tab_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty())
        .collect();
    {
        let mut inner = state.lock();
        inner.live_tabs_known = true;
        inner.live_tab_ids = live;
        let now = now_ms();
        let live_tab_ids = inner.live_tab_ids.clone();
        for task in inner.tasks.values_mut() {
            if task.status.terminal() {
                continue;
            }
            if !live_tab_ids.contains(&task.tab_id) {
                task.status = ScheduledTaskStatus::Cancelled;
                task.next_run_at = None;
                task.current_run_id = None;
                task.last_error = Some("owning tab is no longer restored".to_string());
                task.updated_at = now;
            }
        }
    }
    persist_emit_notify(&state, &app)?;
    Ok(task_list(&state))
}

#[tauri::command]
pub(crate) fn scheduled_tasks_fail_running_for_tab(
    input: ScheduledTaskTabFailureInput,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<Vec<ScheduledTaskRecord>, String> {
    ensure_loaded(&state, &app)?;
    let now = now_ms();
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
        fail_running_tasks_for_tab(&mut inner.tasks, tab_id, now, &reason, IDLE_RETRY_MS)
    };
    if changed {
        persist_emit_notify(&state, &app)?;
    }
    Ok(task_list(&state))
}

#[tauri::command]
pub(crate) fn scheduled_task_create(
    input: ScheduledTaskCreate,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    ensure_loaded(&state, &app)?;
    let now = now_ms();
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
    let schedule = normalize_schedule(input.schedule, now, expires_at)?;
    let mode = input.mode.unwrap_or_else(|| mode_for_schedule(&schedule));
    validate_mode_schedule(mode, &schedule)?;
    let next_run_at = initial_next_run_at(&schedule, now, expires_at)?;
    let label = input
        .label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| label_from_prompt(&prompt));
    let record = ScheduledTaskRecord {
        version: TASK_VERSION,
        id: uuid::Uuid::new_v4().simple().to_string(),
        tab_id,
        cwd,
        model: non_empty(input.model),
        thinking_level: non_empty(input.thinking_level),
        hard_enforce: input.hard_enforce,
        auth_profile_id: non_empty(input.auth_profile_id),
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
        status: ScheduledTaskStatus::Scheduled,
        current_run_id: None,
    };
    {
        let mut inner = state.lock();
        inner.tasks.insert(record.id.clone(), record.clone());
    }
    persist_emit_notify(&state, &app)?;
    Ok(record)
}

#[tauri::command]
pub(crate) fn scheduled_task_update(
    id: String,
    patch: ScheduledTaskUpdate,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    ensure_loaded(&state, &app)?;
    let now = now_ms();
    let updated = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get_mut(&id)
            .ok_or_else(|| format!("unknown task: {id}"))?;
        if matches!(task.status, ScheduledTaskStatus::Running) {
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
            let normalized = normalize_schedule(schedule, now, task.expires_at)?;
            validate_mode_schedule(task.mode, &normalized)?;
            task.next_run_at = initial_next_run_at(&normalized, now, task.expires_at)?;
            task.schedule = normalized;
            if !task.status.terminal() {
                task.status = ScheduledTaskStatus::Scheduled;
            }
        }
        task.updated_at = now;
        task.last_error = None;
        task.clone()
    };
    persist_emit_notify(&state, &app)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn scheduled_task_pause(
    id: String,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    set_status(id, ScheduledTaskStatus::Paused, state, app)
}

#[tauri::command]
pub(crate) fn scheduled_task_resume(
    id: String,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    ensure_loaded(&state, &app)?;
    let now = now_ms();
    let updated = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get_mut(&id)
            .ok_or_else(|| format!("unknown task: {id}"))?;
        if task.status == ScheduledTaskStatus::Running {
            return Err("task is already running".to_string());
        }
        resume_task_record(task, now)?;
        task.updated_at = now;
        task.clone()
    };
    persist_emit_notify(&state, &app)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn scheduled_task_cancel(
    id: String,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    set_status(id, ScheduledTaskStatus::Cancelled, state, app)
}

#[tauri::command]
pub(crate) fn scheduled_task_delete(
    id: String,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    ensure_loaded(&state, &app)?;
    let removed = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get(&id)
            .ok_or_else(|| format!("unknown task: {id}"))?;
        if task.status == ScheduledTaskStatus::Running {
            return Err("cannot delete a running task; stop or wait for completion".to_string());
        }
        inner
            .tasks
            .remove(&id)
            .ok_or_else(|| format!("unknown task: {id}"))?
    };
    persist_emit_notify(&state, &app)?;
    Ok(removed)
}

#[tauri::command]
pub(crate) async fn scheduled_task_run_now(
    id: String,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    ensure_loaded(&state, &app)?;
    start_task_run(&app, &state, &id, true).await
}

#[tauri::command]
pub(crate) fn scheduled_task_schedule_wakeup(
    input: ScheduledTaskWakeupInput,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    ensure_loaded(&state, &app)?;
    let now = now_ms();
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
        if task.mode != ScheduledTaskMode::LoopSelfPaced {
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
        task.schedule = ScheduledTaskSchedule::SelfPaced {
            next_run_at: Some(next),
            reason: non_empty(input.reason),
        };
        task.next_run_at = Some(next);
        task.last_error = None;
        task.updated_at = now;
        task.clone()
    };
    persist_emit_notify(&state, &app)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn scheduled_task_complete(
    input: ScheduledTaskCompleteInput,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    ensure_loaded(&state, &app)?;
    let now = now_ms();
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
            task.status = ScheduledTaskStatus::Failed;
            task.next_run_at = None;
            task.last_error =
                non_empty(input.error).or_else(|| Some("scheduled run failed".to_string()));
        } else {
            task.last_error = None;
            complete_success(task, now, input.complete_task == Some(true))?;
        }
        task.clone()
    };
    persist_emit_notify(&state, &app)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn scheduled_task_resolve_loop_prompt(
    cwd: Option<String>,
    app: AppHandle,
) -> Result<LoopPromptResolution, String> {
    resolve_loop_prompt(cwd.as_deref(), &app)
}

async fn scheduler_loop(app: AppHandle, notify: Arc<Notify>) {
    loop {
        match scheduler_delay(&app) {
            Ok(Some(delay)) => {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = notify.notified() => continue,
                }
            }
            Ok(None) => {
                notify.notified().await;
                continue;
            }
            Err(err) => {
                tracing::warn!(target: "aethon::scheduler", "scheduler tick failed: {err}");
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
        }
        if let Err(err) = fire_due_tasks(&app).await {
            tracing::warn!(target: "aethon::scheduler", "scheduled task dispatch failed: {err}");
        }
    }
}

fn scheduler_delay(app: &AppHandle) -> Result<Option<Duration>, String> {
    let state = app.state::<ScheduledTasksState>();
    ensure_loaded(&state, app)?;
    refresh_expired(&state, app)?;
    let now = now_ms();
    let inner = state.lock();
    if !inner.live_tabs_known {
        return Ok(None);
    }
    let next = inner
        .tasks
        .values()
        .filter(|task| task.status == ScheduledTaskStatus::Scheduled)
        .filter_map(|task| task.next_run_at)
        .min();
    Ok(next.map(|due| {
        if due <= now {
            Duration::from_millis(0)
        } else {
            Duration::from_millis((due - now) as u64)
        }
    }))
}

async fn fire_due_tasks(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ScheduledTasksState>();
    ensure_loaded(&state, app)?;
    for _ in 0..MAX_FIRES_PER_TICK {
        refresh_expired(&state, app)?;
        let now = now_ms();
        let candidate = {
            let inner = state.lock();
            if !inner.live_tabs_known {
                return Ok(());
            }
            inner
                .tasks
                .values()
                .filter(|task| task.status == ScheduledTaskStatus::Scheduled)
                .filter(|task| task.next_run_at.is_some_and(|due| due <= now))
                .filter(|task| inner.live_tab_ids.contains(&task.tab_id))
                .min_by_key(|task| task.next_run_at.unwrap_or(i64::MAX))
                .map(|task| task.id.clone())
        };
        let Some(id) = candidate else {
            break;
        };
        if let Err(err) = start_task_run(app, &state, &id, false).await {
            let _ = delay_due_task(&state, app, &id, err);
        }
    }
    Ok(())
}

async fn start_task_run(
    app: &AppHandle,
    state: &State<'_, ScheduledTasksState>,
    id: &str,
    force: bool,
) -> Result<ScheduledTaskRecord, String> {
    let now = now_ms();
    let task_snapshot = {
        let inner = state.lock();
        let task = inner
            .tasks
            .get(id)
            .ok_or_else(|| format!("unknown task: {id}"))?;
        if !inner.live_tabs_known || !inner.live_tab_ids.contains(&task.tab_id) {
            return Err("owning tab is not restored".to_string());
        }
        if now >= task.expires_at {
            return Err("task has expired".to_string());
        }
        if task.status == ScheduledTaskStatus::Running {
            return Err("task is already running".to_string());
        }
        if force && task.status.terminal() {
            return Err(format!("cannot run terminal task: {:?}", task.status));
        }
        if !force && task.status != ScheduledTaskStatus::Scheduled {
            return Err(format!("task is not scheduled: {:?}", task.status));
        }
        if !force && task.next_run_at.is_none_or(|due| due > now) {
            return Err("task is not due".to_string());
        }
        task.clone()
    };
    if tab_busy(app, &task_snapshot.tab_id) {
        return Err("owning tab is busy".to_string());
    }
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let running = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get_mut(id)
            .ok_or_else(|| format!("unknown task: {id}"))?;
        task.status = ScheduledTaskStatus::Running;
        task.last_run_at = Some(now);
        task.run_count = task.run_count.saturating_add(1);
        task.current_run_id = Some(run_id.clone());
        task.updated_at = now;
        task.last_error = None;
        task.clone()
    };
    persist_emit(state, app)?;
    let _ = app.emit(
        "scheduled-task-fired",
        ScheduledTaskFired {
            task: running.clone(),
            run_id: run_id.clone(),
            visible_prompt: running.visible_prompt.clone(),
        },
    );
    if let Err(err) = dispatch_scheduled_run(app, &running, &run_id).await {
        mark_run_failed(state, app, id, Some(run_id), err.clone())?;
        return Err(err);
    }
    Ok(running)
}

async fn dispatch_scheduled_run(
    app: &AppHandle,
    task: &ScheduledTaskRecord,
    run_id: &str,
) -> Result<(), String> {
    let tab_open = serde_json::json!({
        "type": "tab_open",
        "tabId": task.tab_id,
        "cwd": task.cwd,
        "model": task.model,
        "thinkingLevel": task.thinking_level,
        "authProfileId": task.auth_profile_id,
    });
    let chat = serde_json::json!({
        "type": "chat",
        "tabId": task.tab_id,
        "cwd": task.cwd,
        "model": task.model,
        "thinkingLevel": task.thinking_level,
        "hardEnforce": task.hard_enforce,
        "mode": "normal",
        "content": scheduled_prompt(task, run_id),
        "scheduledTaskId": task.id,
        "scheduledRunId": run_id,
        "scheduledVisiblePrompt": task.visible_prompt,
    });
    dispatch_payload(app, tab_open).await?;
    dispatch_payload(app, chat).await
}

async fn dispatch_payload(app: &AppHandle, payload: serde_json::Value) -> Result<(), String> {
    let agent_state = app.state::<AgentProcesses>();
    let devshell = app.state::<Arc<crate::devshell::DevshellCache>>();
    let startup = app.state::<crate::commands::startup::WorkspaceStartupState>();
    crate::agent_commands::dispatch_agent_payload_value(
        payload,
        agent_state,
        devshell,
        startup,
        app.clone(),
    )
    .await
}

fn scheduled_prompt(task: &ScheduledTaskRecord, run_id: &str) -> String {
    let mut header = format!(
        "This is an Aethon scheduled task run.\nTask id: {}\nRun id: {}\nTask label: {}\n\n",
        task.id, run_id, task.label
    );
    if task.mode == ScheduledTaskMode::LoopSelfPaced {
        header.push_str(
            "This loop is self-paced. When the useful work for this run is complete, call the `scheduleNextLoopWakeup` tool with the task id and run id to choose the next wakeup before ending the turn. If the loop is finished, call `completeLoopTask` instead.\n\n",
        );
    }
    header.push_str("User request:\n");
    header.push_str(&task.prompt);
    header
}

fn complete_success(
    task: &mut ScheduledTaskRecord,
    now: i64,
    complete_task: bool,
) -> Result<(), String> {
    if now >= task.expires_at {
        task.status = ScheduledTaskStatus::Expired;
        task.next_run_at = None;
        return Ok(());
    }
    match &task.schedule {
        ScheduledTaskSchedule::Interval { interval_ms, .. } => {
            let next = now.saturating_add(*interval_ms as i64);
            if next > task.expires_at {
                task.status = ScheduledTaskStatus::Expired;
                task.next_run_at = None;
            } else {
                task.status = ScheduledTaskStatus::Scheduled;
                task.next_run_at = Some(next);
            }
        }
        ScheduledTaskSchedule::SelfPaced { next_run_at, .. } => {
            if complete_task {
                task.status = ScheduledTaskStatus::Completed;
                task.next_run_at = None;
                return Ok(());
            }
            if let Some(next) = *next_run_at
                && next > now
                && next <= task.expires_at
            {
                task.status = ScheduledTaskStatus::Scheduled;
                task.next_run_at = Some(next);
            } else {
                task.status = ScheduledTaskStatus::Paused;
                task.next_run_at = None;
                task.last_error =
                    Some("self-paced loop did not schedule a next wakeup".to_string());
            }
        }
        ScheduledTaskSchedule::OneShot { .. } => {
            task.status = ScheduledTaskStatus::Completed;
            task.next_run_at = None;
        }
        ScheduledTaskSchedule::Cron { expression } => {
            let next = cron_next_run(expression, now)
                .ok_or_else(|| "cron expression produced no future run".to_string())?;
            if next > task.expires_at {
                task.status = ScheduledTaskStatus::Expired;
                task.next_run_at = None;
            } else {
                task.status = ScheduledTaskStatus::Scheduled;
                task.next_run_at = Some(next);
            }
        }
    }
    Ok(())
}

fn mark_run_failed(
    state: &State<'_, ScheduledTasksState>,
    app: &AppHandle,
    id: &str,
    run_id: Option<String>,
    error: String,
) -> Result<(), String> {
    {
        let mut inner = state.lock();
        if let Some(task) = inner.tasks.get_mut(id) {
            task.status = ScheduledTaskStatus::Failed;
            task.next_run_at = None;
            task.current_run_id = None;
            task.last_error = Some(error.clone());
            task.updated_at = now_ms();
        }
    }
    persist_emit_notify(state, app)?;
    let _ = app.emit(
        "scheduled-task-error",
        ScheduledTaskError {
            task_id: id.to_string(),
            run_id,
            message: error,
        },
    );
    Ok(())
}

fn delay_due_task(
    state: &State<'_, ScheduledTasksState>,
    app: &AppHandle,
    id: &str,
    reason: String,
) -> Result<(), String> {
    {
        let mut inner = state.lock();
        if let Some(task) = inner.tasks.get_mut(id)
            && task.status == ScheduledTaskStatus::Scheduled
        {
            task.next_run_at = Some(now_ms().saturating_add(IDLE_RETRY_MS));
            task.coalesced_misses = task.coalesced_misses.saturating_add(1);
            task.last_error = Some(reason);
            task.updated_at = now_ms();
        }
    }
    persist_emit_notify(state, app)
}

fn set_status(
    id: String,
    status: ScheduledTaskStatus,
    state: State<'_, ScheduledTasksState>,
    app: AppHandle,
) -> Result<ScheduledTaskRecord, String> {
    ensure_loaded(&state, &app)?;
    let now = now_ms();
    let updated = {
        let mut inner = state.lock();
        let task = inner
            .tasks
            .get_mut(&id)
            .ok_or_else(|| format!("unknown task: {id}"))?;
        if task.status == ScheduledTaskStatus::Running {
            return Err("cannot change a running task; stop or wait for completion".to_string());
        }
        if status == ScheduledTaskStatus::Paused && task.status.terminal() {
            return Err(format!("cannot pause terminal task: {:?}", task.status));
        }
        task.status = status;
        task.updated_at = now;
        task.current_run_id = None;
        if status == ScheduledTaskStatus::Cancelled {
            task.next_run_at = None;
        }
        task.clone()
    };
    persist_emit_notify(&state, &app)?;
    Ok(updated)
}

fn tab_busy(app: &AppHandle, tab_id: &str) -> bool {
    let key = tab_agent_key(tab_id);
    let state = app.state::<AgentProcesses>();
    let meta = lock_recover(&state.meta, "worker meta (scheduler busy check)");
    meta.get(&key)
        .map(|m| m.prompt_in_flight && !prompt_wedged(m, std::time::Instant::now()))
        .unwrap_or(false)
}

fn task_list(state: &ScheduledTasksState) -> Vec<ScheduledTaskRecord> {
    let mut list: Vec<_> = state.lock().tasks.values().cloned().collect();
    list.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    list
}

fn ensure_loaded(state: &ScheduledTasksState, app: &AppHandle) -> Result<(), String> {
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

fn refresh_expired(state: &ScheduledTasksState, app: &AppHandle) -> Result<(), String> {
    let now = now_ms();
    let mut changed = false;
    {
        let mut inner = state.lock();
        for task in inner.tasks.values_mut() {
            if task.status.terminal() {
                continue;
            }
            if now >= task.expires_at {
                task.status = ScheduledTaskStatus::Expired;
                task.next_run_at = None;
                task.current_run_id = None;
                task.updated_at = now;
                changed = true;
            }
        }
    }
    if changed {
        persist_emit_notify(state, app)?;
    }
    Ok(())
}

fn persist_emit_notify(state: &ScheduledTasksState, app: &AppHandle) -> Result<(), String> {
    persist_emit(state, app)?;
    state.notify.notify_waiters();
    Ok(())
}

fn persist_emit(state: &ScheduledTasksState, app: &AppHandle) -> Result<(), String> {
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

fn recover_loaded_running_tasks(
    tasks: &mut HashMap<String, ScheduledTaskRecord>,
    now: i64,
) -> bool {
    let mut changed = false;
    for task in tasks.values_mut() {
        if task.status != ScheduledTaskStatus::Running {
            continue;
        }
        task.current_run_id = None;
        task.updated_at = now;
        task.last_error = Some("app closed before scheduled run completed".to_string());
        if now >= task.expires_at {
            task.status = ScheduledTaskStatus::Expired;
            task.next_run_at = None;
        } else {
            task.status = ScheduledTaskStatus::Scheduled;
            task.next_run_at = Some(now);
            task.coalesced_misses = task.coalesced_misses.saturating_add(1);
        }
        changed = true;
    }
    changed
}

fn fail_running_tasks_for_tab(
    tasks: &mut HashMap<String, ScheduledTaskRecord>,
    tab_id: Option<&str>,
    now: i64,
    reason: &str,
    retry_delay_ms: i64,
) -> bool {
    let mut changed = false;
    for task in tasks.values_mut() {
        if task.status != ScheduledTaskStatus::Running {
            continue;
        }
        if let Some(tab_id) = tab_id
            && task.tab_id != tab_id
        {
            continue;
        }
        task.current_run_id = None;
        task.updated_at = now;
        task.last_error = Some(reason.to_string());
        if now >= task.expires_at {
            task.status = ScheduledTaskStatus::Expired;
            task.next_run_at = None;
        } else {
            task.status = ScheduledTaskStatus::Scheduled;
            task.next_run_at = Some(now.saturating_add(retry_delay_ms.max(0)));
            task.coalesced_misses = task.coalesced_misses.saturating_add(1);
        }
        changed = true;
    }
    changed
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

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn label_from_prompt(prompt: &str) -> String {
    prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Scheduled task")
        .chars()
        .take(80)
        .collect()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn mode_for_schedule(schedule: &ScheduledTaskSchedule) -> ScheduledTaskMode {
    match schedule {
        ScheduledTaskSchedule::Interval { .. } => ScheduledTaskMode::LoopFixed,
        ScheduledTaskSchedule::SelfPaced { .. } => ScheduledTaskMode::LoopSelfPaced,
        ScheduledTaskSchedule::OneShot { .. } => ScheduledTaskMode::OneShot,
        ScheduledTaskSchedule::Cron { .. } => ScheduledTaskMode::Cron,
    }
}

fn validate_mode_schedule(
    mode: ScheduledTaskMode,
    schedule: &ScheduledTaskSchedule,
) -> Result<(), String> {
    let expected = mode_for_schedule(schedule);
    if mode != expected {
        return Err(format!(
            "mode/schedule mismatch: {:?} cannot use {:?}",
            mode, schedule
        ));
    }
    Ok(())
}

fn normalize_schedule(
    schedule: ScheduledTaskSchedule,
    now: i64,
    expires_at: i64,
) -> Result<ScheduledTaskSchedule, String> {
    match schedule {
        ScheduledTaskSchedule::Interval { interval_ms, label } => {
            if interval_ms < MIN_INTERVAL_MS {
                return Err("interval must be at least 1 minute".to_string());
            }
            if interval_ms > MAX_DELAY_MS {
                return Err("interval must be no more than 7 days".to_string());
            }
            Ok(ScheduledTaskSchedule::Interval { interval_ms, label })
        }
        ScheduledTaskSchedule::SelfPaced {
            next_run_at,
            reason,
        } => {
            if let Some(next) = next_run_at
                && (next < now || next > expires_at)
            {
                return Err("self-paced nextRunAt must be within the task lifetime".to_string());
            }
            Ok(ScheduledTaskSchedule::SelfPaced {
                next_run_at,
                reason,
            })
        }
        ScheduledTaskSchedule::OneShot { run_at } => {
            if run_at <= now {
                return Err("runAt must be in the future".to_string());
            }
            if run_at > expires_at {
                return Err("runAt must be within 7 days".to_string());
            }
            Ok(ScheduledTaskSchedule::OneShot { run_at })
        }
        ScheduledTaskSchedule::Cron { expression } => {
            if cron_next_run(&expression, now).is_none() {
                return Err("cron expression has no run in the next 7 days".to_string());
            }
            Ok(ScheduledTaskSchedule::Cron { expression })
        }
    }
}

fn initial_next_run_at(
    schedule: &ScheduledTaskSchedule,
    now: i64,
    expires_at: i64,
) -> Result<Option<i64>, String> {
    let next = match schedule {
        ScheduledTaskSchedule::Interval { interval_ms, .. } => {
            now.saturating_add(*interval_ms as i64)
        }
        ScheduledTaskSchedule::SelfPaced { next_run_at, .. } => next_run_at.unwrap_or(now),
        ScheduledTaskSchedule::OneShot { run_at } => *run_at,
        ScheduledTaskSchedule::Cron { expression } => cron_next_run(expression, now)
            .ok_or_else(|| "cron expression has no run in the next 7 days".to_string())?,
    };
    if next > expires_at {
        return Err("next run exceeds the task's 7-day lifetime".to_string());
    }
    Ok(Some(next))
}

fn resume_next_run_at(
    schedule: &ScheduledTaskSchedule,
    now: i64,
    expires_at: i64,
) -> Result<Option<i64>, String> {
    match schedule {
        ScheduledTaskSchedule::Interval { interval_ms, .. } => Ok(Some(
            now.saturating_add(*interval_ms as i64).min(expires_at),
        )),
        ScheduledTaskSchedule::SelfPaced { next_run_at, .. } => {
            Ok(Some(next_run_at.unwrap_or(now).min(expires_at)))
        }
        ScheduledTaskSchedule::OneShot { run_at } => Ok(Some((*run_at).min(expires_at))),
        ScheduledTaskSchedule::Cron { expression } => Ok(cron_next_run(expression, now)),
    }
}

fn resume_task_record(task: &mut ScheduledTaskRecord, now: i64) -> Result<(), String> {
    if task.status.terminal() {
        return Err(format!("cannot resume terminal task: {:?}", task.status));
    }
    if now >= task.expires_at {
        task.status = ScheduledTaskStatus::Expired;
        task.next_run_at = None;
    } else {
        task.status = ScheduledTaskStatus::Scheduled;
        if task.next_run_at.is_none_or(|n| n <= now) {
            task.next_run_at = resume_next_run_at(&task.schedule, now, task.expires_at)?;
        }
        task.last_error = None;
    }
    Ok(())
}

fn cron_next_run(expression: &str, after_ms: i64) -> Option<i64> {
    let spec = CronSpec::parse(expression).ok()?;
    let base = Local.timestamp_millis_opt(after_ms).single()?;
    let mut cursor = base
        .with_second(0)?
        .with_nanosecond(0)?
        .checked_add_signed(chrono::Duration::minutes(1))?;
    for _ in 0..(7 * 24 * 60) {
        if spec.matches(cursor) {
            return Some(cursor.timestamp_millis());
        }
        cursor = cursor.checked_add_signed(chrono::Duration::minutes(1))?;
    }
    None
}

#[derive(Debug, PartialEq, Eq)]
struct CronSpec {
    minutes: HashSet<u32>,
    hours: HashSet<u32>,
    days: HashSet<u32>,
    months: HashSet<u32>,
    weekdays: HashSet<u32>,
}

impl CronSpec {
    fn parse(expression: &str) -> Result<Self, String> {
        let parts: Vec<_> = expression.split_whitespace().collect();
        if parts.len() != 5 {
            return Err("cron must have 5 fields".to_string());
        }
        Ok(Self {
            minutes: parse_cron_field(parts[0], 0, 59, false)?,
            hours: parse_cron_field(parts[1], 0, 23, false)?,
            days: parse_cron_field(parts[2], 1, 31, false)?,
            months: parse_cron_field(parts[3], 1, 12, false)?,
            weekdays: parse_cron_field(parts[4], 0, 7, true)?,
        })
    }

    fn matches<Tz: chrono::TimeZone>(&self, dt: chrono::DateTime<Tz>) -> bool {
        let weekday = dt.weekday().num_days_from_sunday();
        self.minutes.contains(&dt.minute())
            && self.hours.contains(&dt.hour())
            && self.days.contains(&dt.day())
            && self.months.contains(&dt.month())
            && self.weekdays.contains(&weekday)
    }
}

fn parse_cron_field(
    field: &str,
    min: u32,
    max: u32,
    weekday: bool,
) -> Result<HashSet<u32>, String> {
    let mut out = HashSet::new();
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err("empty cron field part".to_string());
        }
        let (range, step) = if let Some((range, step)) = part.split_once('/') {
            let step = step
                .parse::<u32>()
                .map_err(|_| "invalid cron step".to_string())?;
            if step == 0 {
                return Err("cron step must be positive".to_string());
            }
            (range, step)
        } else {
            (part, 1)
        };
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((start, end)) = range.split_once('-') {
            (
                parse_cron_value(start, min, max)?,
                parse_cron_value(end, min, max)?,
            )
        } else {
            let value = parse_cron_value(range, min, max)?;
            (value, value)
        };
        if start > end {
            return Err("cron range start exceeds end".to_string());
        }
        let mut value = start;
        while value <= end {
            out.insert(if weekday && value == 7 { 0 } else { value });
            match value.checked_add(step) {
                Some(next) => value = next,
                None => break,
            }
        }
    }
    if out.is_empty() {
        return Err("cron field matched no values".to_string());
    }
    Ok(out)
}

fn parse_cron_value(value: &str, min: u32, max: u32) -> Result<u32, String> {
    let parsed = value
        .parse::<u32>()
        .map_err(|_| format!("invalid cron value: {value}"))?;
    if parsed < min || parsed > max {
        return Err(format!("cron value out of range: {parsed}"));
    }
    Ok(parsed)
}

fn resolve_loop_prompt(cwd: Option<&str>, app: &AppHandle) -> Result<LoopPromptResolution, String> {
    let mut candidates: Vec<(PathBuf, &str)> = Vec::new();
    if let Some(cwd) = cwd.filter(|s| !s.trim().is_empty()) {
        let root = PathBuf::from(cwd);
        candidates.push((
            root.join(".aethon").join("loop.md"),
            "projectAethonLoopFile",
        ));
        candidates.push((
            root.join(".claude").join("loop.md"),
            "projectClaudeLoopFile",
        ));
    }
    if let Ok(home) = app.path().home_dir() {
        candidates.push((home.join(".aethon").join("loop.md"), "userAethonLoopFile"));
        candidates.push((home.join(".claude").join("loop.md"), "userClaudeLoopFile"));
    }
    for (path, source) in candidates {
        if !path.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let limited = if bytes.len() > LOOP_PROMPT_MAX_BYTES {
            &bytes[..LOOP_PROMPT_MAX_BYTES]
        } else {
            &bytes
        };
        let prompt = String::from_utf8_lossy(limited).trim().to_string();
        if !prompt.is_empty() {
            return Ok(LoopPromptResolution {
                prompt,
                source: source.to_string(),
            });
        }
    }
    Ok(LoopPromptResolution {
        prompt: "Review the current project for useful next steps, check status, run lightweight verification if appropriate, and report or act only on actionable work.".to_string(),
        source: "builtInMaintenance".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_task(now: i64, status: ScheduledTaskStatus) -> ScheduledTaskRecord {
        ScheduledTaskRecord {
            version: TASK_VERSION,
            id: "t".into(),
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
            status,
            current_run_id: (status == ScheduledTaskStatus::Running).then(|| "r".into()),
        }
    }

    #[test]
    fn interval_schedule_requires_at_least_one_minute() {
        let now = 1_700_000_000_000;
        let err = normalize_schedule(
            ScheduledTaskSchedule::Interval {
                interval_ms: 30_000,
                label: "30s".to_string(),
            },
            now,
            now + TASK_TTL_MS,
        )
        .unwrap_err();
        assert!(err.contains("at least 1 minute"));
    }

    #[test]
    fn self_paced_defaults_to_immediate_first_run() {
        let now = 1_700_000_000_000;
        let schedule = ScheduledTaskSchedule::SelfPaced {
            next_run_at: None,
            reason: None,
        };
        assert_eq!(
            initial_next_run_at(&schedule, now, now + TASK_TTL_MS).unwrap(),
            Some(now)
        );
    }

    #[test]
    fn cron_field_parses_steps_ranges_and_sunday_alias() {
        let spec = CronSpec::parse("*/15 9-17 * * 0,7").unwrap();
        assert!(spec.minutes.contains(&0));
        assert!(spec.minutes.contains(&45));
        assert!(spec.hours.contains(&9));
        assert!(spec.hours.contains(&17));
        assert!(spec.weekdays.contains(&0));
    }

    #[test]
    fn cron_rejects_bad_expression() {
        assert!(CronSpec::parse("* * *").is_err());
        assert!(CronSpec::parse("*/0 * * * *").is_err());
        assert!(CronSpec::parse("61 * * * *").is_err());
    }

    #[test]
    fn successful_one_shot_completes() {
        let now = 1_700_000_000_000;
        let mut task = test_task(now, ScheduledTaskStatus::Running);
        complete_success(&mut task, now, false).unwrap();
        assert_eq!(task.status, ScheduledTaskStatus::Completed);
        assert_eq!(task.next_run_at, None);
    }

    #[test]
    fn running_tasks_recover_to_scheduled_on_load() {
        let now = 1_700_000_000_000;
        let mut tasks = HashMap::from([(
            "t".to_string(),
            test_task(now - 60_000, ScheduledTaskStatus::Running),
        )]);
        assert!(recover_loaded_running_tasks(&mut tasks, now));
        let task = tasks.get("t").unwrap();
        assert_eq!(task.status, ScheduledTaskStatus::Scheduled);
        assert_eq!(task.next_run_at, Some(now));
        assert_eq!(task.current_run_id, None);
        assert_eq!(task.coalesced_misses, 1);
        assert!(
            task.last_error
                .as_deref()
                .unwrap_or("")
                .contains("app closed")
        );
    }

    #[test]
    fn expired_running_tasks_recover_to_expired_on_load() {
        let now = 1_700_000_000_000;
        let mut task = test_task(now - TASK_TTL_MS - 1, ScheduledTaskStatus::Running);
        task.expires_at = now - 1;
        let mut tasks = HashMap::from([("t".to_string(), task)]);
        assert!(recover_loaded_running_tasks(&mut tasks, now));
        let task = tasks.get("t").unwrap();
        assert_eq!(task.status, ScheduledTaskStatus::Expired);
        assert_eq!(task.next_run_at, None);
        assert_eq!(task.current_run_id, None);
    }

    #[test]
    fn tab_crash_requeues_only_matching_running_tasks() {
        let now = 1_700_000_000_000;
        let crash_at = now + 100;
        let mut other = test_task(now, ScheduledTaskStatus::Running);
        other.id = "other".to_string();
        other.tab_id = "other-tab".to_string();
        let mut paused = test_task(now, ScheduledTaskStatus::Paused);
        paused.id = "paused".to_string();
        let mut tasks = HashMap::from([
            (
                "t".to_string(),
                test_task(now, ScheduledTaskStatus::Running),
            ),
            ("other".to_string(), other),
            ("paused".to_string(), paused),
        ]);
        assert!(fail_running_tasks_for_tab(
            &mut tasks,
            Some("tab"),
            crash_at,
            "worker died",
            IDLE_RETRY_MS,
        ));

        let task = tasks.get("t").unwrap();
        assert_eq!(task.status, ScheduledTaskStatus::Scheduled);
        assert_eq!(task.next_run_at, Some(crash_at + IDLE_RETRY_MS));
        assert_eq!(task.current_run_id, None);
        assert_eq!(task.coalesced_misses, 1);
        assert_eq!(task.last_error.as_deref(), Some("worker died"));
        assert_eq!(
            tasks.get("other").unwrap().status,
            ScheduledTaskStatus::Running
        );
        assert_eq!(
            tasks.get("paused").unwrap().status,
            ScheduledTaskStatus::Paused
        );
    }

    #[test]
    fn process_crash_can_requeue_all_running_tasks() {
        let now = 1_700_000_000_000;
        let mut one = test_task(now, ScheduledTaskStatus::Running);
        one.id = "one".to_string();
        let mut two = test_task(now, ScheduledTaskStatus::Running);
        two.id = "two".to_string();
        two.tab_id = "two-tab".to_string();
        let mut tasks = HashMap::from([("one".to_string(), one), ("two".to_string(), two)]);
        assert!(fail_running_tasks_for_tab(
            &mut tasks,
            None,
            now,
            "agent crashed",
            IDLE_RETRY_MS,
        ));

        for task in tasks.values() {
            assert_eq!(task.status, ScheduledTaskStatus::Scheduled);
            assert_eq!(task.next_run_at, Some(now + IDLE_RETRY_MS));
            assert_eq!(task.current_run_id, None);
            assert_eq!(task.last_error.as_deref(), Some("agent crashed"));
        }
    }

    #[test]
    fn tab_crash_expires_running_task_past_lifetime() {
        let now = 1_700_000_000_000;
        let mut task = test_task(now, ScheduledTaskStatus::Running);
        task.expires_at = now - 1;
        let mut tasks = HashMap::from([("t".to_string(), task)]);
        assert!(fail_running_tasks_for_tab(
            &mut tasks,
            Some("tab"),
            now,
            "worker died",
            IDLE_RETRY_MS,
        ));
        let task = tasks.get("t").unwrap();
        assert_eq!(task.status, ScheduledTaskStatus::Expired);
        assert_eq!(task.next_run_at, None);
        assert_eq!(task.current_run_id, None);
    }

    #[test]
    fn terminal_tasks_cannot_resume() {
        let now = 1_700_000_000_000;
        for status in [
            ScheduledTaskStatus::Cancelled,
            ScheduledTaskStatus::Completed,
            ScheduledTaskStatus::Expired,
        ] {
            let mut task = test_task(now, status);
            let err = resume_task_record(&mut task, now).unwrap_err();
            assert!(err.contains("cannot resume terminal task"));
            assert_eq!(task.status, status);
        }
    }
}
