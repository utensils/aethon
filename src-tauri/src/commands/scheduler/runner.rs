use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use crate::agent_process::{AgentProcesses, lock_recover, prompt_wedged, tab_agent_key};

use super::MAX_FIRES_PER_TICK;
use super::policy::{delay_due_task_record, now_ms};
use super::store::{
    ScheduledTasksState, ensure_loaded, persist_emit, persist_emit_notify, refresh_expired,
};
use super::types::{
    ScheduledTaskError, ScheduledTaskFired, ScheduledTaskMode, ScheduledTaskRecord,
    ScheduledTaskStatus,
};

pub(super) fn boot(app: AppHandle) {
    let state = app.state::<ScheduledTasksState>();
    if let Err(err) = ensure_loaded(&state, &app) {
        tracing::warn!(target: "aethon::scheduler", "scheduled task boot load failed: {err}");
    }
    let notify = state.notify.clone();
    tauri::async_runtime::spawn(async move {
        scheduler_loop(app, notify).await;
    });
}

async fn scheduler_loop(app: AppHandle, notify: std::sync::Arc<Notify>) {
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

pub(super) async fn start_task_run(
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
    let devshell = app.state::<std::sync::Arc<crate::devshell::DevshellCache>>();
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
        if let Some(task) = inner.tasks.get_mut(id) {
            delay_due_task_record(task, now_ms(), reason);
        }
    }
    persist_emit_notify(state, app)
}

fn tab_busy(app: &AppHandle, tab_id: &str) -> bool {
    let key = tab_agent_key(tab_id);
    let state = app.state::<AgentProcesses>();
    let meta = lock_recover(&state.meta, "worker meta (scheduler busy check)");
    meta.get(&key)
        .map(|m| m.prompt_in_flight && !prompt_wedged(m, std::time::Instant::now()))
        .unwrap_or(false)
}
