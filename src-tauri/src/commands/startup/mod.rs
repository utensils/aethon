//! Project/workspace startup command support.
//!
//! The implementation lives here because startup commands need the same
//! OS-near process control and launch-safe PATH handling as devshell
//! preparation, while the frontend only needs a compact IPC/event surface.

mod approval;
mod config;
mod runner;
mod status;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::devshell::DevshellCache;

use approval::{startup_approval_policy, write_approval, write_root_auto_approve};
use config::{
    STARTUP_CONFIG_MAX_BYTES, StartupConfig, parse_startup_config, startup_fingerprint,
    truncate_utf8,
};
use runner::{prepare_devshell_env, run_startup_command};
use status::{StartupEvent, StartupRecord, StartupState, emit_startup_event, status_response};

pub use status::StartupStatusResponse;

const STARTUP_DEVSHELL_TASK_ID: &str = "aethon-devshell";
const STARTUP_DEVSHELL_TASK_LABEL: &str = "Prepare environment";

#[derive(Default)]
pub struct WorkspaceStartupState {
    locks: parking_lot::Mutex<BTreeMap<PathBuf, Arc<AsyncMutex<()>>>>,
    records: parking_lot::Mutex<BTreeMap<PathBuf, StartupRecord>>,
}

impl WorkspaceStartupState {
    fn root_lock(&self, root: &Path) -> Arc<AsyncMutex<()>> {
        let mut locks = self.locks.lock();
        Arc::clone(
            locks
                .entry(root.to_path_buf())
                .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
        )
    }

    fn record(&self, root: &Path) -> Option<StartupRecord> {
        self.records.lock().get(root).cloned()
    }

    fn set_record(&self, root: &Path, record: StartupRecord) {
        self.records.lock().insert(root.to_path_buf(), record);
    }

    fn clear_record(&self, root: &Path) {
        self.records.lock().remove(root);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupPathArgs {
    pub root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupPrepareArgs {
    pub cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupApproveArgs {
    pub root: String,
    pub fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSetAutoApproveArgs {
    pub root: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn workspace_startup_status(
    app: AppHandle,
    state: State<'_, WorkspaceStartupState>,
    args: StartupPathArgs,
) -> Result<StartupStatusResponse, String> {
    let root = canonicalize_root(&PathBuf::from(args.root));
    let config = read_startup_config(&root);
    let fingerprint = startup_fingerprint(&config);
    let policy = startup_approval_policy(&app, &root, &config, &fingerprint)?;
    let record = state.record(&root);
    Ok(status_response(
        &root,
        &config,
        &fingerprint,
        policy,
        record,
    ))
}

#[tauri::command]
pub async fn workspace_startup_approve(
    app: AppHandle,
    state: State<'_, WorkspaceStartupState>,
    args: StartupApproveArgs,
) -> Result<StartupStatusResponse, String> {
    let root = canonicalize_root(&PathBuf::from(args.root));
    let config = read_startup_config(&root);
    let fingerprint = startup_fingerprint(&config);
    if fingerprint != args.fingerprint {
        return Err("startup config changed; review the updated commands".to_string());
    }
    write_approval(&app, &root, &fingerprint)?;
    state.clear_record(&root);
    let policy = startup_approval_policy(&app, &root, &config, &fingerprint)?;
    emit_startup_event(
        &app,
        StartupEvent {
            root: root.display().to_string(),
            fingerprint: fingerprint.clone(),
            state: "idle".to_string(),
            task_id: None,
            task_label: None,
            required: None,
            message: Some("Startup commands approved".to_string()),
            reason: None,
        },
    );
    Ok(status_response(&root, &config, &fingerprint, policy, None))
}

#[tauri::command]
pub async fn workspace_startup_continue(
    app: AppHandle,
    state: State<'_, WorkspaceStartupState>,
    args: StartupApproveArgs,
) -> Result<StartupStatusResponse, String> {
    let root = canonicalize_root(&PathBuf::from(args.root));
    let config = read_startup_config(&root);
    let fingerprint = startup_fingerprint(&config);
    if fingerprint != args.fingerprint {
        return Err("startup config changed; review the updated commands".to_string());
    }
    state.set_record(
        &root,
        StartupRecord {
            fingerprint: fingerprint.clone(),
            state: StartupState::Continued,
            reason: Some("continued by user".to_string()),
            active_task_id: None,
            task_states: BTreeMap::new(),
        },
    );
    emit_startup_event(
        &app,
        StartupEvent {
            root: root.display().to_string(),
            fingerprint: fingerprint.clone(),
            state: "continued".to_string(),
            task_id: None,
            task_label: None,
            required: None,
            message: Some("Continuing without completed startup commands".to_string()),
            reason: Some("continued by user".to_string()),
        },
    );
    let policy = startup_approval_policy(&app, &root, &config, &fingerprint)?;
    Ok(status_response(
        &root,
        &config,
        &fingerprint,
        policy,
        state.record(&root),
    ))
}

#[tauri::command]
pub async fn workspace_startup_set_auto_approve(
    app: AppHandle,
    state: State<'_, WorkspaceStartupState>,
    args: StartupSetAutoApproveArgs,
) -> Result<StartupStatusResponse, String> {
    let root = canonicalize_root(&PathBuf::from(args.root));
    write_root_auto_approve(&app, &root, args.enabled)?;
    state.clear_record(&root);
    let config = read_startup_config(&root);
    let fingerprint = startup_fingerprint(&config);
    let policy = startup_approval_policy(&app, &root, &config, &fingerprint)?;
    Ok(status_response(&root, &config, &fingerprint, policy, None))
}

#[tauri::command]
pub async fn workspace_startup_retry(
    app: AppHandle,
    startup: State<'_, WorkspaceStartupState>,
    devshell: State<'_, Arc<DevshellCache>>,
    args: StartupPathArgs,
) -> Result<StartupStatusResponse, String> {
    let root = canonicalize_root(&PathBuf::from(&args.root));
    startup.clear_record(&root);
    prepare_workspace_startup(&app, &startup, &devshell, &root).await
}

#[tauri::command]
pub async fn workspace_startup_prepare_for_path(
    app: AppHandle,
    startup: State<'_, WorkspaceStartupState>,
    devshell: State<'_, Arc<DevshellCache>>,
    args: StartupPrepareArgs,
) -> Result<StartupStatusResponse, String> {
    let root = canonicalize_root(&PathBuf::from(args.cwd));
    prepare_workspace_startup(&app, &startup, &devshell, &root).await
}

pub(crate) async fn ensure_workspace_startup_ready(
    app: &AppHandle,
    startup: &WorkspaceStartupState,
    devshell: &Arc<DevshellCache>,
    cwd: &str,
) -> Result<(), String> {
    let root = canonicalize_root(&PathBuf::from(cwd));
    let response = prepare_workspace_startup_inner(app, startup, devshell, &root).await?;
    match response.state.as_str() {
        "ready" | "continued" | "disabled" => Ok(()),
        "approval_required" => Err(format!(
            "workspace startup approval required for {}",
            root.display()
        )),
        "failed" => Err(format!(
            "workspace startup failed for {}{}",
            root.display(),
            response
                .reason
                .as_deref()
                .map(|reason| format!(": {reason}"))
                .unwrap_or_default()
        )),
        other => Err(format!("workspace startup not ready ({other})")),
    }
}

async fn prepare_workspace_startup(
    app: &AppHandle,
    startup: &WorkspaceStartupState,
    devshell: &Arc<DevshellCache>,
    root: &Path,
) -> Result<StartupStatusResponse, String> {
    prepare_workspace_startup_inner(app, startup, devshell, root).await
}

async fn prepare_workspace_startup_inner(
    app: &AppHandle,
    startup: &WorkspaceStartupState,
    devshell: &Arc<DevshellCache>,
    root: &Path,
) -> Result<StartupStatusResponse, String> {
    let lock = startup.root_lock(root);
    let _guard = lock.lock().await;

    let config = read_startup_config(root);
    let fingerprint = startup_fingerprint(&config);
    let policy = startup_approval_policy(app, root, &config, &fingerprint)?;
    if let Some(reason) = config.parse_error.clone() {
        let record = StartupRecord {
            fingerprint: fingerprint.clone(),
            state: StartupState::Failed,
            reason: Some(reason.clone()),
            active_task_id: None,
            task_states: BTreeMap::new(),
        };
        startup.set_record(root, record.clone());
        emit_startup_event(
            app,
            StartupEvent {
                root: root.display().to_string(),
                fingerprint: fingerprint.clone(),
                state: "failed".to_string(),
                task_id: None,
                task_label: None,
                required: None,
                message: Some("Startup config could not be parsed".to_string()),
                reason: Some(reason),
            },
        );
        return Ok(status_response(
            root,
            &config,
            &fingerprint,
            policy,
            Some(record),
        ));
    }
    if let Some(record) = startup.record(root)
        && record.fingerprint == fingerprint
        && matches!(record.state, StartupState::Ready | StartupState::Continued)
    {
        return Ok(status_response(
            root,
            &config,
            &fingerprint,
            policy,
            Some(record),
        ));
    }

    startup.set_record(
        root,
        StartupRecord {
            fingerprint: fingerprint.clone(),
            state: StartupState::Running,
            reason: None,
            active_task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
            task_states: BTreeMap::new(),
        },
    );
    emit_startup_event(
        app,
        StartupEvent {
            root: root.display().to_string(),
            fingerprint: fingerprint.clone(),
            state: "running".to_string(),
            task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
            task_label: Some(STARTUP_DEVSHELL_TASK_LABEL.to_string()),
            required: Some(false),
            message: Some("Preparing workspace environment".to_string()),
            reason: None,
        },
    );
    let devshell_env = match prepare_devshell_env(app, devshell, root).await {
        Ok(env) => env,
        Err(reason) => {
            let record = StartupRecord {
                fingerprint: fingerprint.clone(),
                state: StartupState::Failed,
                reason: Some(reason.clone()),
                active_task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
                task_states: BTreeMap::new(),
            };
            startup.set_record(root, record.clone());
            emit_startup_event(
                app,
                StartupEvent {
                    root: root.display().to_string(),
                    fingerprint: fingerprint.clone(),
                    state: "failed".to_string(),
                    task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
                    task_label: Some(STARTUP_DEVSHELL_TASK_LABEL.to_string()),
                    required: Some(false),
                    message: Some("Workspace environment failed".to_string()),
                    reason: Some(reason),
                },
            );
            return Ok(status_response(
                root,
                &config,
                &fingerprint,
                policy,
                Some(record),
            ));
        }
    };
    emit_startup_event(
        app,
        StartupEvent {
            root: root.display().to_string(),
            fingerprint: fingerprint.clone(),
            state: "ready".to_string(),
            task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
            task_label: Some(STARTUP_DEVSHELL_TASK_LABEL.to_string()),
            required: Some(false),
            message: Some("Workspace environment ready".to_string()),
            reason: None,
        },
    );

    if !policy.approved {
        let record = StartupRecord {
            fingerprint: fingerprint.clone(),
            state: StartupState::ApprovalRequired,
            reason: Some("startup commands require approval".to_string()),
            active_task_id: None,
            task_states: BTreeMap::new(),
        };
        startup.set_record(root, record.clone());
        emit_startup_event(
            app,
            StartupEvent {
                root: root.display().to_string(),
                fingerprint: fingerprint.clone(),
                state: "approval_required".to_string(),
                task_id: None,
                task_label: None,
                required: None,
                message: Some("Startup commands require approval".to_string()),
                reason: record.reason.clone(),
            },
        );
        return Ok(status_response(
            root,
            &config,
            &fingerprint,
            policy,
            Some(record),
        ));
    }

    startup.set_record(
        root,
        StartupRecord {
            fingerprint: fingerprint.clone(),
            state: StartupState::Running,
            reason: None,
            active_task_id: None,
            task_states: BTreeMap::new(),
        },
    );

    let mut task_states = BTreeMap::new();
    for command in &config.commands {
        task_states.insert(command.id.clone(), StartupState::Running);
        startup.set_record(
            root,
            StartupRecord {
                fingerprint: fingerprint.clone(),
                state: StartupState::Running,
                reason: None,
                active_task_id: Some(command.id.clone()),
                task_states: task_states.clone(),
            },
        );
        emit_startup_event(
            app,
            StartupEvent {
                root: root.display().to_string(),
                fingerprint: fingerprint.clone(),
                state: "running".to_string(),
                task_id: Some(command.id.clone()),
                task_label: Some(command.label.clone()),
                required: Some(command.required),
                message: Some(format!("Running {}", command.label)),
                reason: None,
            },
        );
        let result = run_startup_command(app, root, &fingerprint, command, &devshell_env).await;
        match result {
            Ok(()) => {
                task_states.insert(command.id.clone(), StartupState::Ready);
                emit_startup_event(
                    app,
                    StartupEvent {
                        root: root.display().to_string(),
                        fingerprint: fingerprint.clone(),
                        state: "ready".to_string(),
                        task_id: Some(command.id.clone()),
                        task_label: Some(command.label.clone()),
                        required: Some(command.required),
                        message: Some(format!("{} completed", command.label)),
                        reason: None,
                    },
                )
            }
            Err(reason) if command.required => {
                task_states.insert(command.id.clone(), StartupState::Failed);
                let record = StartupRecord {
                    fingerprint: fingerprint.clone(),
                    state: StartupState::Failed,
                    reason: Some(reason.clone()),
                    active_task_id: Some(command.id.clone()),
                    task_states: task_states.clone(),
                };
                startup.set_record(root, record.clone());
                emit_startup_event(
                    app,
                    StartupEvent {
                        root: root.display().to_string(),
                        fingerprint: fingerprint.clone(),
                        state: "failed".to_string(),
                        task_id: Some(command.id.clone()),
                        task_label: Some(command.label.clone()),
                        required: Some(command.required),
                        message: Some(format!("{} failed", command.label)),
                        reason: Some(reason),
                    },
                );
                return Ok(status_response(
                    root,
                    &config,
                    &fingerprint,
                    policy,
                    Some(record),
                ));
            }
            Err(reason) => {
                task_states.insert(command.id.clone(), StartupState::Failed);
                emit_startup_event(
                    app,
                    StartupEvent {
                        root: root.display().to_string(),
                        fingerprint: fingerprint.clone(),
                        state: "failed".to_string(),
                        task_id: Some(command.id.clone()),
                        task_label: Some(command.label.clone()),
                        required: Some(command.required),
                        message: Some(format!("{} failed; continuing", command.label)),
                        reason: Some(reason),
                    },
                )
            }
        }
    }

    if !config.commands.is_empty() {
        startup.set_record(
            root,
            StartupRecord {
                fingerprint: fingerprint.clone(),
                state: StartupState::Running,
                reason: None,
                active_task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
                task_states: task_states.clone(),
            },
        );
        emit_startup_event(
            app,
            StartupEvent {
                root: root.display().to_string(),
                fingerprint: fingerprint.clone(),
                state: "running".to_string(),
                task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
                task_label: Some(STARTUP_DEVSHELL_TASK_LABEL.to_string()),
                required: Some(false),
                message: Some("Refreshing workspace environment".to_string()),
                reason: None,
            },
        );
        if let Err(reason) = prepare_devshell_env(app, devshell, root).await {
            let record = StartupRecord {
                fingerprint: fingerprint.clone(),
                state: StartupState::Failed,
                reason: Some(reason.clone()),
                active_task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
                task_states: task_states.clone(),
            };
            startup.set_record(root, record.clone());
            emit_startup_event(
                app,
                StartupEvent {
                    root: root.display().to_string(),
                    fingerprint: fingerprint.clone(),
                    state: "failed".to_string(),
                    task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
                    task_label: Some(STARTUP_DEVSHELL_TASK_LABEL.to_string()),
                    required: Some(false),
                    message: Some("Workspace environment refresh failed".to_string()),
                    reason: Some(reason),
                },
            );
            return Ok(status_response(
                root,
                &config,
                &fingerprint,
                policy,
                Some(record),
            ));
        }
        emit_startup_event(
            app,
            StartupEvent {
                root: root.display().to_string(),
                fingerprint: fingerprint.clone(),
                state: "ready".to_string(),
                task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
                task_label: Some(STARTUP_DEVSHELL_TASK_LABEL.to_string()),
                required: Some(false),
                message: Some("Workspace environment ready".to_string()),
                reason: None,
            },
        );
    }

    let record = StartupRecord {
        fingerprint: fingerprint.clone(),
        state: StartupState::Ready,
        reason: None,
        active_task_id: None,
        task_states,
    };
    startup.set_record(root, record.clone());
    emit_startup_event(
        app,
        StartupEvent {
            root: root.display().to_string(),
            fingerprint: fingerprint.clone(),
            state: "ready".to_string(),
            task_id: None,
            task_label: None,
            required: None,
            message: Some("Workspace startup complete".to_string()),
            reason: None,
        },
    );
    Ok(status_response(
        root,
        &config,
        &fingerprint,
        policy,
        Some(record),
    ))
}

fn read_startup_config(root: &Path) -> StartupConfig {
    let path = root.join(".aethon").join("startup.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => truncate_utf8(text, STARTUP_CONFIG_MAX_BYTES),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            tracing::warn!(
                target: "aethon::startup",
                "read {} failed: {e}; using empty startup config",
                path.display()
            );
            String::new()
        }
    };
    parse_startup_config(&text)
}

fn canonicalize_root(root: &Path) -> PathBuf {
    std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

#[cfg(test)]
mod tests;
