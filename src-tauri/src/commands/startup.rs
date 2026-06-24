//! Project/workspace startup command support.
//!
//! The implementation lives here because startup commands need the same
//! OS-near process control and launch-safe PATH handling as devshell
//! preparation, while the frontend only needs a compact IPC/event surface.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::Mutex as AsyncMutex;

use crate::devshell::DevshellCache;

const STARTUP_CONFIG_MAX_BYTES: usize = 64 * 1024;
const STARTUP_APPROVALS_FILE: &str = "startup-approvals.json";
const STARTUP_DEFAULT_TIMEOUT_SECONDS: u64 = 600;
const STARTUP_MAX_TIMEOUT_SECONDS: u64 = 24 * 60 * 60;
const STARTUP_DEVSHELL_TASK_ID: &str = "aethon-devshell";
const STARTUP_DEVSHELL_TASK_LABEL: &str = "Prepare environment";

#[derive(Default)]
pub struct WorkspaceStartupState {
    locks: parking_lot::Mutex<BTreeMap<PathBuf, Arc<AsyncMutex<()>>>>,
    records: parking_lot::Mutex<BTreeMap<PathBuf, StartupRecord>>,
}

#[derive(Debug, Clone)]
struct StartupRecord {
    fingerprint: String,
    state: StartupState,
    reason: Option<String>,
    active_task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StartupState {
    Ready,
    ApprovalRequired,
    Running,
    Failed,
    Continued,
}

impl StartupState {
    fn as_str(&self) -> &'static str {
        match self {
            StartupState::Ready => "ready",
            StartupState::ApprovalRequired => "approval_required",
            StartupState::Running => "running",
            StartupState::Failed => "failed",
            StartupState::Continued => "continued",
        }
    }
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupConfig {
    pub timeout_seconds: u64,
    pub auto_approve: bool,
    pub commands: Vec<StartupCommandConfig>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupCommandConfig {
    pub id: String,
    pub label: String,
    pub command: String,
    pub required: bool,
    pub timeout_seconds: u64,
}

#[derive(Default, Deserialize)]
struct RawStartupToml {
    #[serde(default)]
    startup: RawStartupSection,
}

#[derive(Default, Deserialize)]
struct RawStartupSection {
    timeout_seconds: Option<u64>,
    // Deprecated and intentionally ignored for approval decisions: project
    // config is repo-controlled, while startup command trust must be user-owned.
    auto_approve: Option<bool>,
    commands: Option<Vec<RawStartupCommand>>,
}

#[derive(Default, Deserialize)]
struct RawStartupCommand {
    id: Option<String>,
    label: Option<String>,
    command: Option<String>,
    required: Option<bool>,
    timeout_seconds: Option<u64>,
}

pub(crate) fn parse_startup_config(input: &str) -> StartupConfig {
    let parsed = if input.trim().is_empty() {
        RawStartupToml::default()
    } else {
        toml::from_str::<RawStartupToml>(input).unwrap_or_default()
    };
    let timeout_seconds = normalize_timeout(parsed.startup.timeout_seconds);
    let mut warnings = Vec::new();
    if parsed.startup.auto_approve == Some(true) {
        warnings.push(
            "Ignored [startup].auto_approve from project config; configure startup trust in Aethon"
                .to_string(),
        );
    }
    let commands = parsed
        .startup
        .commands
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .filter_map(|(idx, raw)| {
            let command = raw.command.unwrap_or_default().trim().to_string();
            if command.is_empty() {
                warnings.push(format!(
                    "Skipped startup command {} because command is missing",
                    idx + 1
                ));
                return None;
            }
            let id = raw
                .id
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("command-{}", idx + 1));
            let label = raw
                .label
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| id.clone());
            Some(StartupCommandConfig {
                id,
                label,
                command,
                required: raw.required.unwrap_or(true),
                timeout_seconds: normalize_timeout(raw.timeout_seconds.or(Some(timeout_seconds))),
            })
        })
        .collect();
    StartupConfig {
        timeout_seconds,
        auto_approve: false,
        commands,
        warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
    }
}

fn normalize_timeout(value: Option<u64>) -> u64 {
    value
        .filter(|n| *n > 0)
        .unwrap_or(STARTUP_DEFAULT_TIMEOUT_SECONDS)
        .min(STARTUP_MAX_TIMEOUT_SECONDS)
}

pub(crate) fn startup_fingerprint(config: &StartupConfig) -> String {
    let mut hasher = Sha1::new();
    hasher.update(b"aethon-startup:v1");
    hasher.update(config.timeout_seconds.to_le_bytes());
    for command in &config.commands {
        hasher.update(command.id.as_bytes());
        hasher.update(b"\0");
        hasher.update(command.label.as_bytes());
        hasher.update(b"\0");
        hasher.update(command.command.as_bytes());
        hasher.update(b"\0");
        hasher.update([u8::from(command.required)]);
        hasher.update(command.timeout_seconds.to_le_bytes());
    }
    hex_sha1(hasher.finalize().as_slice())
}

fn hex_sha1(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
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
struct StartupApprovalPolicy {
    approved: bool,
    auto_approve: bool,
    host_auto_approve: bool,
    project_auto_approve: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StartupEvent {
    root: String,
    fingerprint: String,
    state: String,
    task_id: Option<String>,
    task_label: Option<String>,
    required: Option<bool>,
    message: Option<String>,
    reason: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StartupOutputEvent {
    root: String,
    fingerprint: String,
    task_id: String,
    task_label: String,
    stream: String,
    content: String,
}

#[derive(Default, Serialize, Deserialize)]
struct ApprovalStore {
    #[serde(default)]
    approvals: BTreeMap<String, String>,
    #[serde(default)]
    auto_approve_roots: BTreeMap<String, bool>,
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
        },
    );

    for command in &config.commands {
        startup.set_record(
            root,
            StartupRecord {
                fingerprint: fingerprint.clone(),
                state: StartupState::Running,
                reason: None,
                active_task_id: Some(command.id.clone()),
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
            Ok(()) => emit_startup_event(
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
            ),
            Err(reason) if command.required => {
                let record = StartupRecord {
                    fingerprint: fingerprint.clone(),
                    state: StartupState::Failed,
                    reason: Some(reason.clone()),
                    active_task_id: Some(command.id.clone()),
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
            Err(reason) => emit_startup_event(
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
            ),
        }
    }

    let record = StartupRecord {
        fingerprint: fingerprint.clone(),
        state: StartupState::Ready,
        reason: None,
        active_task_id: None,
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

async fn prepare_devshell_env(
    app: &AppHandle,
    cache: &Arc<DevshellCache>,
    root: &Path,
) -> Result<BTreeMap<String, String>, String> {
    let (enabled, configured_mode) = crate::devshell::effective_config(app, root).into_parts();
    if enabled == "never" {
        return Ok(BTreeMap::new());
    }
    if let Some(reason) =
        crate::commands::devshell::forced_mode_mismatch_reason(root, configured_mode)
    {
        return Err(format!("devshell prepare: {reason}"));
    }
    let Some(kind) = crate::devshell::detect_mode(root, configured_mode) else {
        let reason = format!("no devshell detected at {}", root.display());
        if let Some(error) =
            crate::commands::devshell::required_devshell_missing_error(&enabled, reason)
        {
            return Err(format!("devshell prepare: {error}"));
        }
        return Ok(BTreeMap::new());
    };
    if kind.as_str() == "direnv"
        && let Err(reason) = crate::commands::devshell::direnv_allow(root).await
    {
        if crate::commands::devshell::devshell_prepare_is_required(&enabled) {
            return Err(reason);
        }
        tracing::warn!(
            target: "aethon::startup",
            "startup devshell direnv allow failed for {}: {reason}; continuing with host env",
            root.display()
        );
        return Ok(BTreeMap::new());
    }
    let emitter = crate::commands::devshell::emitter_for(app);
    match cache
        .prepare_for(Some(&emitter), root, configured_mode)
        .await
    {
        Ok(prepared) => Ok(prepared.env),
        Err(reason) => {
            if crate::commands::devshell::devshell_prepare_is_required(&enabled) {
                Err(format!("devshell prepare: {reason}"))
            } else {
                tracing::warn!(
                    target: "aethon::startup",
                    "startup devshell prepare failed for {}: {reason}; continuing with host env",
                    root.display()
                );
                Ok(BTreeMap::new())
            }
        }
    }
}

async fn run_startup_command(
    app: &AppHandle,
    root: &Path,
    fingerprint: &str,
    cfg: &StartupCommandConfig,
    devshell_env: &BTreeMap<String, String>,
) -> Result<(), String> {
    let mut command = shell_command(&cfg.command);
    command
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in devshell_env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("{} failed to start: {e}", cfg.label))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = stdout.map(|stream| {
        tokio::spawn(read_command_stream(
            app.clone(),
            root.display().to_string(),
            fingerprint.to_string(),
            cfg.id.clone(),
            cfg.label.clone(),
            "stdout".to_string(),
            stream,
        ))
    });
    let stderr_task = stderr.map(|stream| {
        tokio::spawn(read_command_stream(
            app.clone(),
            root.display().to_string(),
            fingerprint.to_string(),
            cfg.id.clone(),
            cfg.label.clone(),
            "stderr".to_string(),
            stream,
        ))
    });
    let wait = child.wait();
    let status = match tokio::time::timeout(Duration::from_secs(cfg.timeout_seconds), wait).await {
        Ok(result) => result.map_err(|e| format!("{} wait failed: {e}", cfg.label))?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(format!(
                "{} timed out after {}s",
                cfg.label, cfg.timeout_seconds
            ));
        }
    };
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} exited with {}", cfg.label, status))
    }
}

async fn read_command_stream<R: AsyncRead + Unpin>(
    app: AppHandle,
    root: String,
    fingerprint: String,
    task_id: String,
    task_label: String,
    stream: String,
    reader: R,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let content = format!("{line}\n");
        let _ = app.emit(
            "workspace-startup-output",
            StartupOutputEvent {
                root: root.clone(),
                fingerprint: fingerprint.clone(),
                task_id: task_id.clone(),
                task_label: task_label.clone(),
                stream: stream.clone(),
                content,
            },
        );
    }
}

fn shell_command(script: &str) -> tokio::process::Command {
    if cfg!(windows) {
        let mut command = crate::env::tokio_command("cmd");
        command.args(["/C", script]);
        command
    } else {
        let mut command = crate::env::tokio_command("sh");
        command.args(["-lc", script]);
        command
    }
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

fn status_response(
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
    let state = matching_record
        .as_ref()
        .map(|record| record.state.as_str())
        .unwrap_or(if config.commands.is_empty() {
            "disabled"
        } else if policy.approved {
            "idle"
        } else {
            "approval_required"
        });
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
        reason: matching_record.and_then(|record| record.reason),
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

fn truncate_utf8(mut text: String, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}

fn startup_approval_policy(
    app: &AppHandle,
    root: &Path,
    config: &StartupConfig,
    fingerprint: &str,
) -> Result<StartupApprovalPolicy, String> {
    let host_auto_approve = host_startup_auto_approve(app)?;
    let store = read_approval_store(app)?;
    let project_auto_approve = store
        .auto_approve_roots
        .get(&root.display().to_string())
        .copied()
        .unwrap_or(false);
    let auto_approve = host_auto_approve || project_auto_approve;
    let approved = config.commands.is_empty()
        || auto_approve
        || store
            .approvals
            .get(&root.display().to_string())
            .is_some_and(|stored| stored == fingerprint);
    Ok(StartupApprovalPolicy {
        approved,
        auto_approve,
        host_auto_approve,
        project_auto_approve,
    })
}

fn host_startup_auto_approve(app: &AppHandle) -> Result<bool, String> {
    let path = crate::commands::config::aethon_state_path(app, "config.toml")?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => truncate_utf8(text, STARTUP_CONFIG_MAX_BYTES),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            tracing::warn!(
                target: "aethon::startup",
                "read {} failed: {e}; host startup auto-approve disabled",
                path.display()
            );
            String::new()
        }
    };
    Ok(crate::helpers::parse_host_startup_auto_approve(&text))
}

fn write_root_auto_approve(app: &AppHandle, root: &Path, enabled: bool) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let mut store = read_approval_store(app)?;
    let key = root.display().to_string();
    if enabled {
        store.auto_approve_roots.insert(key, true);
    } else {
        store.auto_approve_roots.remove(&key);
    }
    write_approval_store(app, &store)
}

fn write_approval(app: &AppHandle, root: &Path, fingerprint: &str) -> Result<(), String> {
    let mut store = read_approval_store(app)?;
    store
        .approvals
        .insert(root.display().to_string(), fingerprint.to_string());
    write_approval_store(app, &store)
}

fn write_approval_store(app: &AppHandle, store: &ApprovalStore) -> Result<(), String> {
    let path = approvals_path(app)?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

fn read_approval_store(app: &AppHandle) -> Result<ApprovalStore, String> {
    let path = approvals_path(app)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ApprovalStore::default()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn approvals_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.join(STARTUP_APPROVALS_FILE))
}

fn canonicalize_root(root: &Path) -> PathBuf {
    std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

fn emit_startup_event(app: &AppHandle, event: StartupEvent) {
    if let Err(err) = app.emit("workspace-startup-status", event) {
        tracing::warn!(target: "aethon::startup", "emit workspace-startup-status failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(approved: bool) -> StartupApprovalPolicy {
        StartupApprovalPolicy {
            approved,
            auto_approve: false,
            host_auto_approve: false,
            project_auto_approve: false,
        }
    }

    #[test]
    fn parse_startup_config_defaults_commands_to_required() {
        let cfg = parse_startup_config(
            r#"[startup]
timeout_seconds = 42

[[startup.commands]]
id = "deps"
label = "Install dependencies"
command = "bun install"
"#,
        );

        assert_eq!(cfg.timeout_seconds, 42);
        assert_eq!(cfg.commands.len(), 1);
        assert_eq!(cfg.commands[0].id, "deps");
        assert_eq!(cfg.commands[0].label, "Install dependencies");
        assert_eq!(cfg.commands[0].command, "bun install");
        assert!(cfg.commands[0].required);
        assert_eq!(cfg.commands[0].timeout_seconds, 42);
    }

    #[test]
    fn parse_startup_config_ignores_project_auto_approve() {
        let cfg = parse_startup_config(
            r#"[startup]
auto_approve = true

[[startup.commands]]
command = "bun install"
"#,
        );

        assert!(!cfg.auto_approve);
        assert_eq!(cfg.commands.len(), 1);
        assert!(cfg
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("Ignored [startup].auto_approve")));
    }

    #[test]
    fn parse_startup_config_honors_optional_and_per_command_timeout() {
        let cfg = parse_startup_config(
            r#"[startup]
timeout_seconds = 600

[[startup.commands]]
id = "assets"
command = "bun run assets"
required = false
timeout_seconds = 5
"#,
        );

        assert_eq!(cfg.commands.len(), 1);
        assert!(!cfg.commands[0].required);
        assert_eq!(cfg.commands[0].timeout_seconds, 5);
    }

    #[test]
    fn startup_fingerprint_changes_when_command_changes() {
        let a = startup_fingerprint(&parse_startup_config(
            r#"[[startup.commands]]
id = "deps"
command = "bun install"
"#,
        ));
        let b = startup_fingerprint(&parse_startup_config(
            r#"[[startup.commands]]
id = "deps"
command = "bun install --frozen-lockfile"
"#,
        ));

        assert_ne!(a, b);
    }

    #[test]
    fn status_response_keeps_environment_task_visible_after_approval_gate() {
        let cfg = parse_startup_config(
            r#"[[startup.commands]]
id = "deps"
command = "bun install"
"#,
        );
        let fingerprint = startup_fingerprint(&cfg);
        let response = status_response(
            Path::new("/tmp/example"),
            &cfg,
            &fingerprint,
            policy(false),
            Some(StartupRecord {
                fingerprint: fingerprint.clone(),
                state: StartupState::ApprovalRequired,
                reason: Some("startup commands require approval".to_string()),
                active_task_id: None,
            }),
        );

        assert_eq!(response.state, "approval_required");
        assert_eq!(response.commands[0].id, STARTUP_DEVSHELL_TASK_ID);
        assert_eq!(response.commands[0].state, "ready");
        assert_eq!(response.commands[1].id, "deps");
        assert_eq!(response.commands[1].state, "idle");
    }

    #[test]
    fn status_response_marks_failed_startup_command() {
        let cfg = parse_startup_config(
            r#"[[startup.commands]]
id = "deps"
command = "bun install"
"#,
        );
        let fingerprint = startup_fingerprint(&cfg);
        let response = status_response(
            Path::new("/tmp/example"),
            &cfg,
            &fingerprint,
            policy(true),
            Some(StartupRecord {
                fingerprint: fingerprint.clone(),
                state: StartupState::Failed,
                reason: Some("deps exited with 1".to_string()),
                active_task_id: Some("deps".to_string()),
            }),
        );

        assert_eq!(response.state, "failed");
        assert_eq!(response.commands[0].state, "idle");
        assert_eq!(response.commands[1].state, "failed");
    }

    #[test]
    fn status_response_marks_failed_environment_task() {
        let cfg = parse_startup_config("");
        let fingerprint = startup_fingerprint(&cfg);
        let response = status_response(
            Path::new("/tmp/example"),
            &cfg,
            &fingerprint,
            policy(true),
            Some(StartupRecord {
                fingerprint: fingerprint.clone(),
                state: StartupState::Failed,
                reason: Some("devshell prepare failed".to_string()),
                active_task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
            }),
        );

        assert_eq!(response.state, "failed");
        assert_eq!(response.commands.len(), 1);
        assert_eq!(response.commands[0].id, STARTUP_DEVSHELL_TASK_ID);
        assert_eq!(response.commands[0].state, "failed");
    }

    #[test]
    fn status_response_reports_auto_approve_sources() {
        let cfg = parse_startup_config(
            r#"[[startup.commands]]
command = "bun install"
"#,
        );
        let fingerprint = startup_fingerprint(&cfg);
        let response = status_response(
            Path::new("/tmp/example"),
            &cfg,
            &fingerprint,
            StartupApprovalPolicy {
                approved: true,
                auto_approve: true,
                host_auto_approve: true,
                project_auto_approve: false,
            },
            None,
        );

        assert!(response.approved);
        assert!(response.auto_approve);
        assert!(response.host_auto_approve);
        assert!(!response.project_auto_approve);
        assert_eq!(response.state, "idle");
    }

    #[test]
    fn truncate_utf8_keeps_char_boundary() {
        let input = format!("{}é", "a".repeat(STARTUP_CONFIG_MAX_BYTES - 1));
        let truncated = truncate_utf8(input, STARTUP_CONFIG_MAX_BYTES);

        assert_eq!(truncated.len(), STARTUP_CONFIG_MAX_BYTES - 1);
        assert!(truncated.is_char_boundary(truncated.len()));
    }
}
