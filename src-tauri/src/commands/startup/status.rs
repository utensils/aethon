use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::config::{StartupCommandConfig, StartupConfig};
use super::{STARTUP_DEVSHELL_TASK_ID, STARTUP_DEVSHELL_TASK_LABEL};

#[derive(Debug, Clone)]
pub(super) struct StartupRecord {
    pub(super) fingerprint: String,
    pub(super) state: StartupState,
    pub(super) reason: Option<String>,
    pub(super) active_task_id: Option<String>,
    pub(super) task_states: BTreeMap<String, StartupState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum StartupState {
    Ready,
    ApprovalRequired,
    Running,
    Failed,
    Continued,
}

impl StartupState {
    pub(super) fn as_str(&self) -> &'static str {
        match self {
            StartupState::Ready => "ready",
            StartupState::ApprovalRequired => "approval_required",
            StartupState::Running => "running",
            StartupState::Failed => "failed",
            StartupState::Continued => "continued",
        }
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartupTaskStatus {
    pub id: String,
    pub label: String,
    pub required: bool,
    pub state: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatusResponse {
    pub root: String,
    pub fingerprint: String,
    pub state: String,
    pub approved: bool,
    pub auto_approve: bool,
    pub host_auto_approve: bool,
    pub project_auto_approve: bool,
    pub commands: Vec<StartupTaskStatus>,
    pub warning: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct StartupApprovalPolicy {
    pub(super) approved: bool,
    pub(super) auto_approve: bool,
    pub(super) host_auto_approve: bool,
    pub(super) project_auto_approve: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartupEvent {
    pub(super) root: String,
    pub(super) fingerprint: String,
    pub(super) state: String,
    pub(super) task_id: Option<String>,
    pub(super) task_label: Option<String>,
    pub(super) required: Option<bool>,
    pub(super) message: Option<String>,
    pub(super) reason: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartupOutputEvent {
    pub(super) root: String,
    pub(super) fingerprint: String,
    pub(super) task_id: String,
    pub(super) task_label: String,
    pub(super) stream: String,
    pub(super) content: String,
}

pub(super) fn status_response(
    root: &Path,
    config: &StartupConfig,
    fingerprint: &str,
    policy: StartupApprovalPolicy,
    record: Option<StartupRecord>,
) -> StartupStatusResponse {
    let matching_record = record
        .as_ref()
        .filter(|record| record.fingerprint == fingerprint)
        .cloned();
    let state = config.parse_error.as_ref().map_or_else(
        || {
            matching_record
                .as_ref()
                .map(|record| record.state.as_str())
                .unwrap_or(if config.commands.is_empty() {
                    "disabled"
                } else if policy.approved {
                    "idle"
                } else {
                    "approval_required"
                })
        },
        |_| "failed",
    );
    let mut commands = Vec::with_capacity(config.commands.len() + 1);
    commands.push(StartupTaskStatus {
        id: STARTUP_DEVSHELL_TASK_ID.to_string(),
        label: STARTUP_DEVSHELL_TASK_LABEL.to_string(),
        required: false,
        state: devshell_task_state(matching_record.as_ref()).to_string(),
    });
    commands.extend(config.commands.iter().map(|command| StartupTaskStatus {
        id: command.id.clone(),
        label: command.label.clone(),
        required: command.required,
        state: command_task_state(command, matching_record.as_ref()).to_string(),
    }));
    StartupStatusResponse {
        root: root.display().to_string(),
        fingerprint: fingerprint.to_string(),
        state: state.to_string(),
        approved: policy.approved,
        auto_approve: policy.auto_approve,
        host_auto_approve: policy.host_auto_approve,
        project_auto_approve: policy.project_auto_approve,
        commands,
        warning: config.warning.clone(),
        reason: config
            .parse_error
            .clone()
            .or_else(|| matching_record.and_then(|record| record.reason)),
    }
}

fn devshell_task_state(record: Option<&StartupRecord>) -> &'static str {
    let Some(record) = record else {
        return "idle";
    };
    match record.state {
        StartupState::Failed
            if record.active_task_id.as_deref() == Some(STARTUP_DEVSHELL_TASK_ID) =>
        {
            "failed"
        }
        StartupState::Running
            if record.active_task_id.as_deref() == Some(STARTUP_DEVSHELL_TASK_ID) =>
        {
            "running"
        }
        StartupState::ApprovalRequired | StartupState::Running | StartupState::Ready => "ready",
        StartupState::Failed | StartupState::Continued => "idle",
    }
}

fn command_task_state(
    command: &StartupCommandConfig,
    record: Option<&StartupRecord>,
) -> &'static str {
    let Some(record) = record else {
        return "idle";
    };
    if let Some(state) = record.task_states.get(&command.id) {
        return state.as_str();
    }
    match record.state {
        StartupState::Ready => "ready",
        StartupState::Running if record.active_task_id.as_deref() == Some(command.id.as_str()) => {
            "running"
        }
        StartupState::Failed if record.active_task_id.as_deref() == Some(command.id.as_str()) => {
            "failed"
        }
        _ => "idle",
    }
}

pub(super) fn emit_startup_event(app: &AppHandle, event: StartupEvent) {
    if let Err(err) = app.emit("workspace-startup-status", event) {
        tracing::warn!(target: "aethon::startup", "emit workspace-startup-status failed: {err}");
    }
}
