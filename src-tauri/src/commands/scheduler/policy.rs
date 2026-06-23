use std::collections::{HashMap, HashSet};

use super::cron::cron_next_run;
use super::types::{
    ScheduledTaskMode, ScheduledTaskRecord, ScheduledTaskReuseInput, ScheduledTaskSchedule,
    ScheduledTaskStatus, ScheduledTaskUpdate,
};
use super::{MAX_DELAY_MS, MIN_INTERVAL_MS, TASK_TTL_MS};

pub(super) fn recover_loaded_running_tasks(
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

pub(super) fn fail_running_tasks_for_tab(
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

pub(super) fn reconcile_live_tabs(
    tasks: &mut HashMap<String, ScheduledTaskRecord>,
    live_tab_ids: &HashSet<String>,
    now: i64,
) {
    for task in tasks.values_mut() {
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

pub(super) fn expire_due_tasks(tasks: &mut HashMap<String, ScheduledTaskRecord>, now: i64) -> bool {
    let mut changed = false;
    for task in tasks.values_mut() {
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
    changed
}

pub(super) fn complete_success(
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

pub(super) fn delay_due_task_record(task: &mut ScheduledTaskRecord, now: i64, reason: String) {
    if task.status == ScheduledTaskStatus::Scheduled {
        task.next_run_at = Some(now.saturating_add(super::IDLE_RETRY_MS));
        task.coalesced_misses = task.coalesced_misses.saturating_add(1);
        task.last_error = Some(reason);
        task.updated_at = now;
    }
}

pub(super) fn apply_task_update(
    task: &mut ScheduledTaskRecord,
    patch: ScheduledTaskUpdate,
    now: i64,
) -> Result<(), String> {
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
    let requested_mode = patch.mode.unwrap_or(task.mode);
    if let Some(schedule) = patch.schedule {
        let normalized = normalize_schedule(schedule, now, task.expires_at)?;
        validate_mode_schedule(requested_mode, &normalized)?;
        task.next_run_at = initial_next_run_at(&normalized, now, task.expires_at)?;
        task.mode = requested_mode;
        task.schedule = normalized;
        if !task.status.terminal() && task.status != ScheduledTaskStatus::Paused {
            task.status = ScheduledTaskStatus::Scheduled;
        }
    } else if let Some(mode) = patch.mode {
        validate_mode_schedule(mode, &task.schedule)?;
        task.mode = mode;
    }
    task.updated_at = now;
    task.last_error = None;
    Ok(())
}

pub(super) fn set_status_record(
    task: &mut ScheduledTaskRecord,
    status: ScheduledTaskStatus,
    now: i64,
) -> Result<(), String> {
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
    Ok(())
}

pub(super) fn resume_task_record(task: &mut ScheduledTaskRecord, now: i64) -> Result<(), String> {
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

pub(super) fn reuse_task_record(
    task: &mut ScheduledTaskRecord,
    input: ScheduledTaskReuseInput,
    now: i64,
) -> Result<(), String> {
    if task.status == ScheduledTaskStatus::Running {
        return Err("cannot reuse a running task".to_string());
    }
    if !matches!(
        task.mode,
        ScheduledTaskMode::LoopFixed | ScheduledTaskMode::LoopSelfPaced | ScheduledTaskMode::Cron
    ) {
        return Err("only loop tasks can be reused".to_string());
    }
    let tab_id = input.tab_id.trim();
    if tab_id.is_empty() {
        return Err("tabId required".to_string());
    }
    let cwd = input.cwd.trim();
    if cwd.is_empty() {
        return Err("cwd required".to_string());
    }
    task.tab_id = tab_id.to_string();
    task.cwd = cwd.to_string();
    task.model = non_empty(input.model);
    task.thinking_level = non_empty(input.thinking_level);
    task.hard_enforce = input.hard_enforce;
    task.auth_profile_id = non_empty(input.auth_profile_id);
    task.expires_at = now.saturating_add(TASK_TTL_MS);
    task.current_run_id = None;
    task.last_error = None;
    task.status = ScheduledTaskStatus::Scheduled;
    task.next_run_at = resume_next_run_at(&task.schedule, now, task.expires_at)?;
    task.updated_at = now;
    Ok(())
}

pub(super) fn mode_for_schedule(schedule: &ScheduledTaskSchedule) -> ScheduledTaskMode {
    match schedule {
        ScheduledTaskSchedule::Interval { .. } => ScheduledTaskMode::LoopFixed,
        ScheduledTaskSchedule::SelfPaced { .. } => ScheduledTaskMode::LoopSelfPaced,
        ScheduledTaskSchedule::OneShot { .. } => ScheduledTaskMode::OneShot,
        ScheduledTaskSchedule::Cron { .. } => ScheduledTaskMode::Cron,
    }
}

pub(super) fn validate_mode_schedule(
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

pub(super) fn normalize_schedule(
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

pub(super) fn initial_next_run_at(
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

pub(super) fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(super) fn label_from_prompt(prompt: &str) -> String {
    prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Scheduled task")
        .chars()
        .take(80)
        .collect()
}

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::commands::scheduler::{TASK_VERSION, types::*};

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
            super::super::IDLE_RETRY_MS,
        ));

        let task = tasks.get("t").unwrap();
        assert_eq!(task.status, ScheduledTaskStatus::Scheduled);
        assert_eq!(
            task.next_run_at,
            Some(crash_at + super::super::IDLE_RETRY_MS)
        );
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
            super::super::IDLE_RETRY_MS,
        ));

        for task in tasks.values() {
            assert_eq!(task.status, ScheduledTaskStatus::Scheduled);
            assert_eq!(task.next_run_at, Some(now + super::super::IDLE_RETRY_MS));
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
            super::super::IDLE_RETRY_MS,
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

    #[test]
    fn update_keeps_paused_tasks_paused_when_schedule_changes() {
        let now = 1_700_000_000_000;
        let mut task = test_task(now, ScheduledTaskStatus::Paused);
        task.mode = ScheduledTaskMode::LoopFixed;
        task.schedule = ScheduledTaskSchedule::Interval {
            interval_ms: 30 * 60_000,
            label: "30m".to_string(),
        };
        task.next_run_at = None;

        apply_task_update(
            &mut task,
            ScheduledTaskUpdate {
                label: None,
                prompt: Some("updated prompt".to_string()),
                visible_prompt: Some("updated prompt".to_string()),
                mode: Some(ScheduledTaskMode::LoopFixed),
                schedule: Some(ScheduledTaskSchedule::Interval {
                    interval_ms: 5 * 60_000,
                    label: "5m".to_string(),
                }),
            },
            now,
        )
        .unwrap();

        assert_eq!(task.status, ScheduledTaskStatus::Paused);
        assert_eq!(task.prompt, "updated prompt");
        assert_eq!(task.next_run_at, Some(now + 5 * 60_000));
    }

    #[test]
    fn reuse_rebinds_cancelled_loop_to_new_tab() {
        let now = 1_700_000_000_000;
        let mut task = test_task(now, ScheduledTaskStatus::Cancelled);
        task.mode = ScheduledTaskMode::LoopSelfPaced;
        task.schedule = ScheduledTaskSchedule::SelfPaced {
            next_run_at: None,
            reason: None,
        };
        task.next_run_at = None;
        task.last_error = Some("owning tab is no longer restored".to_string());
        let task_id = task.id.clone();

        reuse_task_record(
            &mut task,
            ScheduledTaskReuseInput {
                task_id,
                tab_id: "new-tab".to_string(),
                cwd: "/repo/new".to_string(),
                model: Some("openai-codex/gpt-5.5".to_string()),
                thinking_level: Some("high".to_string()),
                hard_enforce: Some(true),
                auth_profile_id: Some("openai-codex-primary".to_string()),
            },
            now,
        )
        .unwrap();

        assert_eq!(task.tab_id, "new-tab");
        assert_eq!(task.cwd, "/repo/new");
        assert_eq!(task.model.as_deref(), Some("openai-codex/gpt-5.5"));
        assert_eq!(task.thinking_level.as_deref(), Some("high"));
        assert_eq!(task.hard_enforce, Some(true));
        assert_eq!(
            task.auth_profile_id.as_deref(),
            Some("openai-codex-primary")
        );
        assert_eq!(task.status, ScheduledTaskStatus::Scheduled);
        assert_eq!(task.next_run_at, Some(now));
        assert_eq!(task.last_error, None);
    }

    #[test]
    fn reuse_refreshes_expired_loop_lifetime() {
        let now = 1_700_000_000_000;
        let mut task = test_task(now, ScheduledTaskStatus::Expired);
        task.mode = ScheduledTaskMode::LoopFixed;
        task.schedule = ScheduledTaskSchedule::Interval {
            interval_ms: 5 * 60_000,
            label: "5m".to_string(),
        };
        task.next_run_at = None;
        task.expires_at = now - 1;
        let task_id = task.id.clone();

        reuse_task_record(
            &mut task,
            ScheduledTaskReuseInput {
                task_id,
                tab_id: "new-tab".to_string(),
                cwd: "/repo/new".to_string(),
                model: None,
                thinking_level: None,
                hard_enforce: None,
                auth_profile_id: None,
            },
            now,
        )
        .unwrap();

        assert_eq!(task.status, ScheduledTaskStatus::Scheduled);
        assert_eq!(task.expires_at, now + TASK_TTL_MS);
        assert_eq!(task.next_run_at, Some(now + 5 * 60_000));
    }
}
