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
    pub(crate) fn terminal(self) -> bool {
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
    pub(crate) version: u8,
    pub(crate) id: String,
    pub(crate) tab_id: String,
    pub(crate) cwd: String,
    pub(crate) model: Option<String>,
    pub(crate) thinking_level: Option<String>,
    pub(crate) hard_enforce: Option<bool>,
    pub(crate) auth_profile_id: Option<String>,
    pub(crate) label: String,
    pub(crate) prompt: String,
    pub(crate) visible_prompt: String,
    pub(crate) prompt_source: String,
    pub(crate) mode: ScheduledTaskMode,
    pub(crate) schedule: ScheduledTaskSchedule,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) next_run_at: Option<i64>,
    pub(crate) last_run_at: Option<i64>,
    pub(crate) last_completed_at: Option<i64>,
    pub(crate) expires_at: i64,
    pub(crate) run_count: u32,
    pub(crate) coalesced_misses: u32,
    pub(crate) last_error: Option<String>,
    pub(crate) status: ScheduledTaskStatus,
    pub(crate) current_run_id: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskCreate {
    pub(crate) tab_id: String,
    pub(crate) cwd: String,
    pub(crate) model: Option<String>,
    pub(crate) thinking_level: Option<String>,
    pub(crate) hard_enforce: Option<bool>,
    pub(crate) auth_profile_id: Option<String>,
    pub(crate) label: Option<String>,
    pub(crate) prompt: String,
    pub(crate) visible_prompt: Option<String>,
    pub(crate) prompt_source: Option<String>,
    pub(crate) mode: Option<ScheduledTaskMode>,
    pub(crate) schedule: ScheduledTaskSchedule,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskUpdate {
    pub(crate) label: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) visible_prompt: Option<String>,
    pub(crate) schedule: Option<ScheduledTaskSchedule>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskCompleteInput {
    pub(crate) task_id: String,
    pub(crate) run_id: String,
    pub(crate) success: bool,
    pub(crate) error: Option<String>,
    pub(crate) complete_task: Option<bool>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskWakeupInput {
    pub(crate) task_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) next_run_at: Option<i64>,
    pub(crate) delay_ms: Option<u64>,
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskTabFailureInput {
    pub(crate) tab_id: Option<String>,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopPromptResolution {
    pub(crate) prompt: String,
    pub(crate) source: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledTaskFired {
    pub(crate) task: ScheduledTaskRecord,
    pub(crate) run_id: String,
    pub(crate) visible_prompt: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledTaskError {
    pub(crate) task_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) message: String,
}
