//! Post-update boot probation: if an updater install yields a build that
//! can't reach a healthy UI within a short timer, restore the previous
//! `.app` bundle from a backup taken just before the install and relaunch.
//!
//! Lifted from Claudette (`src-tauri/src/boot_probation.rs`) with the
//! storage roots, env vars, and tracing target rebased on Aethon's
//! conventions. The flow is unchanged:
//!
//! 1. `prepare_for_update` runs synchronously on the tokio blocking pool
//!    just before `download_and_install`: take a recursive copy of the
//!    currently-installed `.app` into `<aethon_dir>/updates/previous/<ver>/`,
//!    write a sentinel JSON to `<aethon_dir>/boot-probation.json`.
//! 2. The Tauri shell restarts post-install. `start_monitor` (in
//!    `setup()`) sees the sentinel, increments `attempts`, and arms a
//!    cancellable timer. The frontend has `DEFAULT_PROBATION_SECS` to
//!    invoke `boot_ok` (which cancels the timer and clears the sentinel).
//! 3. On timeout, this module marks the sentinel `RollbackInProgress`,
//!    spawns a helper subprocess (the current binary with
//!    `--boot-rollback-helper <sentinel> <pid>`), and exits. The helper
//!    waits for the parent PID to actually die, copies the backup back
//!    over the `.app`, relaunches Aethon, and writes a
//!    `boot-rollback-report.json` describing what happened so the next
//!    launch can show an Ok/Failed dialog.
//!
//! macOS-aarch64 is the only platform Aethon ships today, but the
//! `#[cfg(...)]`-gated branches for Linux/Windows are preserved verbatim
//! so the unit tests run unchanged on a Linux dev host.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::Notify;

const SENTINEL_FILE: &str = "boot-probation.json";
const REPORT_FILE: &str = "boot-rollback-report.json";
const DEFAULT_PROBATION_SECS: u64 = 20;
/// Hard floor / ceiling for the env-var override. A 0-second probation
/// would never let `boot_ok` race the timer; a 2-minute probation makes
/// the rollback feel broken to users on the unhappy path.
const MIN_PROBATION_SECS: u64 = 1;
const MAX_PROBATION_SECS: u64 = 120;
const LOG_TAIL_BYTES: u64 = 16 * 1024;
static PROBATION_FILE_LOCK: Mutex<()> = Mutex::new(());
/// After this many recorded launch attempts on the same sentinel, we
/// stop arming the rollback. The user has already booted past the
/// probation window once (otherwise we'd have rolled back on attempt 1)
/// — that's the strongest "this build runs" signal we can collect
/// without IPC. Force-quits during the probation window otherwise loop
/// the user back to the rolled-back version forever.
const MAX_PROBATION_ATTEMPTS: u32 = 2;

fn probation_timeout() -> Duration {
    let raw = std::env::var("AETHON_BOOT_PROBATION_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_PROBATION_SECS);
    Duration::from_secs(raw.clamp(MIN_PROBATION_SECS, MAX_PROBATION_SECS))
}

#[derive(Default)]
pub struct BootProbationState {
    acknowledged: AtomicBool,
    cancel: Notify,
}

impl BootProbationState {
    pub fn acknowledge(&self) {
        self.acknowledged.store(true, Ordering::SeqCst);
        self.cancel.notify_waiters();
    }

    fn is_acknowledged(&self) -> bool {
        self.acknowledged.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstallKind {
    MacApp,
    LinuxAppImage,
    WindowsInstallDir,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProbationStatus {
    Pending,
    RollbackInProgress,
    RollbackFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BootStage {
    ProcessStarted,
    WebviewCreated,
    ReactMounted,
    InitialDataLoading,
    InitialDataFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct BootStageRecord {
    pub stage: BootStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub recorded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct BootProbation {
    pub status: ProbationStatus,
    pub failed_version: String,
    pub previous_version: String,
    pub download_url: String,
    pub install_kind: InstallKind,
    pub target_path: PathBuf,
    pub executable_path: PathBuf,
    pub backup_path: Option<PathBuf>,
    pub backup_error: Option<String>,
    pub attempts: u32,
    pub data_dir: PathBuf,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_stage: Option<BootStageRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probation_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_tail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct BootRollbackReport {
    pub failed_version: String,
    pub previous_version: String,
    pub download_url: String,
    pub restored: bool,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_stage: Option<BootStageRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probation_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_tail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InstallTarget {
    kind: InstallKind,
    target_path: PathBuf,
    executable_path: PathBuf,
    is_dir: bool,
}

pub fn sentinel_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SENTINEL_FILE)
}

pub fn report_path(data_dir: &Path) -> PathBuf {
    data_dir.join(REPORT_FILE)
}

/// `<aethon_dir>/updates/previous/<sanitised-version>/` — where we stash
/// the .app bundle pre-update so the boot helper can swap it back.
pub fn updates_previous_dir(data_dir: &Path, version: &str) -> PathBuf {
    data_dir
        .join("updates")
        .join("previous")
        .join(sanitize_path_segment(version))
}

pub fn prepare_for_update(
    data_dir: &Path,
    current_version: &str,
    next_version: &str,
    download_url: &str,
) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("create data dir {}: {e}", data_dir.display()))?;

    let target = detect_install_target().unwrap_or_else(|e| {
        tracing::warn!(
            target: "aethon::updater",
            error = %e,
            "boot probation could not detect self-contained install target"
        );
        InstallTarget {
            kind: InstallKind::Unsupported,
            target_path: PathBuf::new(),
            executable_path: std::env::current_exe().unwrap_or_default(),
            is_dir: false,
        }
    });

    let (backup_path, backup_error) = match create_backup(data_dir, &target, current_version) {
        Ok(Some(path)) => (Some(path), None),
        Ok(None) => (None, None),
        Err(e) => {
            tracing::warn!(
                target: "aethon::updater",
                error = %e,
                "boot probation backup failed; rollback will degrade to a diagnostic report"
            );
            (None, Some(e))
        }
    };

    let probation = BootProbation {
        status: ProbationStatus::Pending,
        failed_version: next_version.to_string(),
        previous_version: current_version.to_string(),
        download_url: download_url.to_string(),
        install_kind: target.kind,
        target_path: target.target_path,
        executable_path: target.executable_path,
        backup_path,
        backup_error,
        attempts: 0,
        data_dir: data_dir.to_path_buf(),
        created_at: chrono::Utc::now().to_rfc3339(),
        latest_stage: None,
        probation_secs: None,
        log_tail: None,
    };

    write_probation(data_dir, &probation)
}

pub fn record_boot_stage(
    data_dir: &Path,
    stage: BootStage,
    detail: Option<String>,
) -> Result<bool, String> {
    let _guard = PROBATION_FILE_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let path = sentinel_path(data_dir);
    if !path.exists() {
        return Ok(false);
    }
    let mut probation = read_probation_path(&path)?;

    if !matches!(probation.status, ProbationStatus::Pending) {
        return Ok(false);
    }

    if !apply_boot_stage(&mut probation, stage, detail) {
        return Ok(false);
    }
    write_probation(data_dir, &probation)?;
    Ok(true)
}

/// Mark this boot as healthy so the in-memory timer is cancelled and
/// the on-disk sentinel is dropped.
///
/// Order is deliberate: we ack the in-memory state **before** attempting
/// the file delete. If `remove_file` fails (disk full, permission
/// denied, weirder filesystem state), the timer is already cancelled —
/// we'd rather acknowledge a healthy build and leak a stale sentinel
/// than fail fast and let the rollback fire on a perfectly working
/// build. The next launch's `start_monitor` will increment `attempts`
/// on the leaked sentinel; `MAX_PROBATION_ATTEMPTS` then bounds the
/// retries so the leak self-heals on the second healthy boot.
pub fn acknowledge_boot(data_dir: &Path, state: &Arc<BootProbationState>) -> Result<(), String> {
    state.acknowledge();
    let path = sentinel_path(data_dir);
    let _guard = PROBATION_FILE_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("clear boot probation {}: {e}", path.display())),
    }
}

pub fn start_monitor(app: AppHandle, state: Arc<BootProbationState>, data_dir: PathBuf) {
    let path = sentinel_path(&data_dir);
    let _guard = PROBATION_FILE_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let Ok(mut probation) = read_probation_path(&path) else {
        return;
    };
    // RollbackFailed: a previous launch already tried and surfaced the
    // user-facing dialog — don't try again, the report is one-shot.
    // RollbackInProgress: a previous launch's helper is currently
    // restoring the backup and waiting on parent exit. Re-arming here
    // would race the helper for the install location and could spawn
    // a second helper that competes with it.
    if matches!(
        probation.status,
        ProbationStatus::RollbackFailed | ProbationStatus::RollbackInProgress
    ) {
        return;
    }

    apply_boot_stage(&mut probation, BootStage::WebviewCreated, None);
    probation.attempts = probation.attempts.saturating_add(1);

    // Bounded retry: once we've recorded MAX_PROBATION_ATTEMPTS launches
    // without a rollback firing, the user has booted past the timer at
    // least once. Treat the build as healthy, drop the sentinel, and
    // skip arming. Without this bound, a user who force-quits during
    // every probation window would keep tripping rollbacks on a build
    // that actually works for them.
    if probation.attempts >= MAX_PROBATION_ATTEMPTS {
        tracing::info!(
            target: "aethon::updater",
            attempts = probation.attempts,
            failed_version = %probation.failed_version,
            "boot probation cleared after reaching attempt threshold without a rollback"
        );
        let _ = std::fs::remove_file(&path);
        return;
    }

    if let Err(e) = write_probation(&data_dir, &probation) {
        tracing::warn!(target: "aethon::updater", error = %e, "failed to update boot probation attempt count");
    }

    let timeout = probation_timeout();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = state.cancel.notified() => {}
            _ = tokio::time::sleep(timeout) => {
                if state.is_acknowledged() {
                    return;
                }
                handle_probation_timeout(&app, &data_dir).await;
            }
        }
    });
}

pub fn show_pending_report(app: &AppHandle, data_dir: &Path) {
    let path = report_path(data_dir);
    let Ok(report) = read_report_path(&path) else {
        return;
    };
    let _ = std::fs::remove_file(&path);

    let title = if report.restored {
        "Aethon update rolled back"
    } else {
        "Aethon update rollback failed"
    };
    let message = rollback_report_message(&report);

    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

pub fn run_helper_from_args(args: &[String]) -> Option<Result<(), String>> {
    let idx = args
        .iter()
        .position(|arg| arg == "--boot-rollback-helper")?;
    let sentinel = args.get(idx + 1).map(PathBuf::from);
    let parent_pid = args.get(idx + 2).and_then(|raw| raw.parse::<u32>().ok());
    Some(match (sentinel, parent_pid) {
        (Some(sentinel), Some(parent_pid)) => run_helper(&sentinel, parent_pid),
        _ => Err("usage: --boot-rollback-helper <sentinel-path> <parent-pid>".to_string()),
    })
}

async fn handle_probation_timeout(app: &AppHandle, data_dir: &Path) {
    // BootProbation is ~hundreds of bytes — keep the SpawnHelper variant
    // boxed so the enum's stack footprint matches the Exit variant.
    enum TimeoutAction {
        Exit,
        SpawnHelper(Box<BootProbation>),
    }

    let path = sentinel_path(data_dir);
    let action = {
        let _guard = PROBATION_FILE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut probation = match read_probation_path(&path) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(target: "aethon::updater", error = %e, "boot probation timed out but sentinel could not be read");
                return;
            }
        };

        finalize_probation_timeout(&mut probation);

        if probation.backup_path.is_none() {
            let error = probation.backup_error.clone().unwrap_or_else(|| {
                "No previous install backup is available for this update target.".to_string()
            });
            probation.status = ProbationStatus::RollbackFailed;
            let _ = write_probation(data_dir, &probation);
            let _ = write_report(
                data_dir,
                &rollback_report_from_probation(&probation, false, Some(error)),
            );
            TimeoutAction::Exit
        } else {
            probation.status = ProbationStatus::RollbackInProgress;
            if let Err(e) = write_probation(data_dir, &probation) {
                tracing::warn!(target: "aethon::updater", error = %e, "failed to mark boot rollback in progress");
            }
            TimeoutAction::SpawnHelper(Box::new(probation))
        }
    };

    let TimeoutAction::SpawnHelper(probation) = action else {
        app.exit(1);
        return;
    };

    match spawn_rollback_helper(&path) {
        Ok(()) => app.exit(1),
        Err(e) => {
            tracing::error!(target: "aethon::updater", error = %e, "failed to spawn boot rollback helper");
            let mut failed = *probation;
            failed.status = ProbationStatus::RollbackFailed;
            let _ = write_probation(data_dir, &failed);
            let _ = write_report(
                data_dir,
                &rollback_report_from_probation(&failed, false, Some(e)),
            );
            app.exit(1);
        }
    }
}

fn run_helper(sentinel: &Path, parent_pid: u32) -> Result<(), String> {
    let probation = read_probation_path(sentinel)?;
    wait_for_parent_exit(parent_pid, Duration::from_secs(20));

    let result = restore_backup(&probation)
        .and_then(|_| relaunch(&probation))
        .map(|_| rollback_report_from_probation(&probation, true, None))
        .unwrap_or_else(|e| rollback_report_from_probation(&probation, false, Some(e)));

    if result.restored {
        let _ = std::fs::remove_file(sentinel);
    } else {
        let mut failed = probation;
        failed.status = ProbationStatus::RollbackFailed;
        let _ = write_probation(&failed.data_dir.clone(), &failed);
    }
    write_report(&result_path_parent(sentinel), &result)
}

fn restore_backup(probation: &BootProbation) -> Result<(), String> {
    let backup = probation
        .backup_path
        .as_deref()
        .ok_or_else(|| "No previous install backup is available.".to_string())?;
    if !backup.exists() {
        return Err(format!("backup path is missing: {}", backup.display()));
    }

    if probation.target_path.exists() {
        remove_path(&probation.target_path).map_err(|e| {
            format!(
                "remove failed install {}: {e}",
                probation.target_path.display()
            )
        })?;
    }
    copy_path(backup, &probation.target_path)
        .map_err(|e| format!("restore {}: {e}", probation.target_path.display()))
}

fn relaunch(probation: &BootProbation) -> Result<(), String> {
    std::process::Command::new(&probation.executable_path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("relaunch {}: {e}", probation.executable_path.display()))
}

fn spawn_rollback_helper(sentinel: &Path) -> Result<(), String> {
    let helper = helper_executable(sentinel)?;
    std::process::Command::new(&helper)
        .arg("--boot-rollback-helper")
        .arg(sentinel)
        .arg(std::process::id().to_string())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("spawn rollback helper {}: {e}", helper.display()))
}

#[cfg(windows)]
fn helper_executable(sentinel: &Path) -> Result<PathBuf, String> {
    // Windows holds an exclusive lock on a running .exe, so the helper
    // cannot run from inside the install dir we're about to rewrite.
    // Stage a copy alongside the sentinel (data dir, outside the install
    // tree) and run that one instead.
    let current = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let helper = result_path_parent(sentinel).join("boot-rollback-helper.exe");
    std::fs::copy(&current, &helper)
        .map_err(|e| format!("copy rollback helper {}: {e}", helper.display()))?;
    Ok(helper)
}

#[cfg(not(windows))]
fn helper_executable(_sentinel: &Path) -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("current_exe: {e}"))
}

fn wait_for_parent_exit(pid: u32, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline && is_pid_alive(pid) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if r == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn is_pid_alive(_pid: u32) -> bool {
    false
}

fn detect_install_target() -> Result<InstallTarget, String> {
    let executable_path = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    detect_install_target_from_exe(&executable_path)
}

fn detect_install_target_from_exe(executable_path: &Path) -> Result<InstallTarget, String> {
    #[cfg(target_os = "macos")]
    {
        let app = mac_app_root(executable_path)?;
        return Ok(InstallTarget {
            kind: InstallKind::MacApp,
            target_path: app,
            executable_path: executable_path.to_path_buf(),
            is_dir: true,
        });
    }

    #[cfg(target_os = "linux")]
    {
        let appimage = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .unwrap_or_else(|| executable_path.to_path_buf());
        return Ok(InstallTarget {
            kind: InstallKind::LinuxAppImage,
            target_path: appimage.clone(),
            executable_path: appimage,
            is_dir: false,
        });
    }

    #[cfg(windows)]
    {
        let dir = executable_path
            .parent()
            .ok_or_else(|| "current executable has no parent directory".to_string())?
            .to_path_buf();
        return Ok(InstallTarget {
            kind: InstallKind::WindowsInstallDir,
            target_path: dir,
            executable_path: executable_path.to_path_buf(),
            is_dir: true,
        });
    }

    #[allow(unreachable_code)]
    Err("unsupported updater target".to_string())
}

#[cfg(target_os = "macos")]
fn mac_app_root(executable_path: &Path) -> Result<PathBuf, String> {
    let mut cur = executable_path;
    while let Some(parent) = cur.parent() {
        if parent.extension().and_then(|s| s.to_str()) == Some("app") {
            return Ok(parent.to_path_buf());
        }
        cur = parent;
    }
    Err(format!(
        "could not find .app root for {}",
        executable_path.display()
    ))
}

fn create_backup(
    data_dir: &Path,
    target: &InstallTarget,
    current_version: &str,
) -> Result<Option<PathBuf>, String> {
    if target.kind == InstallKind::Unsupported || target.target_path.as_os_str().is_empty() {
        return Ok(None);
    }
    let backup_root = updates_previous_dir(data_dir, current_version);
    if backup_root.exists() {
        remove_path(&backup_root)
            .map_err(|e| format!("remove stale backup {}: {e}", backup_root.display()))?;
    }
    std::fs::create_dir_all(&backup_root)
        .map_err(|e| format!("create backup dir {}: {e}", backup_root.display()))?;

    let name = target
        .target_path
        .file_name()
        .ok_or_else(|| format!("target has no file name: {}", target.target_path.display()))?;
    let backup_path = backup_root.join(name);
    copy_path(&target.target_path, &backup_path)
        .map_err(|e| format!("copy backup {}: {e}", backup_path.display()))?;
    if target.is_dir && !backup_path.is_dir() {
        return Err(format!(
            "backup is not a directory: {}",
            backup_path.display()
        ));
    }
    // GC stale backups from prior versions. We keep only the
    // just-written one — at this point the new install hasn't been
    // staged yet, so this is the *only* backup we'll need to fall
    // back on. A 200-300 MB `.app` bundle accumulating once per
    // update would otherwise turn `~/.aethon/updates/previous/`
    // into a slow disk leak.
    prune_stale_backups(&backup_root);
    Ok(Some(backup_path))
}

/// Best-effort sweep of `<aethon_dir>/updates/previous/`. Deletes every
/// versioned subdirectory except `keep`. Failures are logged and
/// swallowed — a residual backup is never worse than aborting the
/// update mid-flight.
fn prune_stale_backups(keep: &Path) {
    let Some(parent) = keep.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let keep_name = keep.file_name();
    for entry in entries.flatten() {
        if Some(entry.file_name().as_os_str()) == keep_name {
            continue;
        }
        let path = entry.path();
        if let Err(e) = remove_path(&path) {
            tracing::warn!(
                target: "aethon::updater",
                path = %path.display(),
                error = %e,
                "failed to GC stale boot rollback backup"
            );
        }
    }
}

/// Recursive `cp -a` that preserves symlinks.
///
/// macOS `.app` bundles routinely contain symlinks inside `Frameworks/`
/// (e.g. `Foo.framework/Foo -> Versions/Current/Foo`). Plain
/// `std::fs::copy` follows symlinks and a symlink-to-directory then
/// errors with `Is a directory`, so we branch on `file_type()` and
/// recreate links via `std::os::*::fs::symlink*` like `cp -R` does.
fn copy_path(from: &Path, to: &Path) -> std::io::Result<()> {
    let file_type = std::fs::symlink_metadata(from)?.file_type();
    if file_type.is_symlink() {
        copy_symlink(from, to)
    } else if file_type.is_dir() {
        copy_dir_recursive(from, to)
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to)?;
        let meta = std::fs::metadata(from)?;
        std::fs::set_permissions(to, meta.permissions())?;
        Ok(())
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let dest = to.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            copy_symlink(&source, &dest)?;
        } else if file_type.is_dir() {
            copy_dir_recursive(&source, &dest)?;
        } else {
            std::fs::copy(&source, &dest)?;
            let meta = entry.metadata()?;
            std::fs::set_permissions(&dest, meta.permissions())?;
        }
    }
    let permissions = std::fs::metadata(from)?.permissions();
    std::fs::set_permissions(to, permissions)?;
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::symlink;
    let target = std::fs::read_link(from)?;
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    remove_path_no_follow(to)?;
    symlink(target, to)
}

#[cfg(windows)]
fn copy_symlink(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let target = std::fs::read_link(from)?;
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    remove_path_no_follow(to)?;
    let is_dir = from.metadata().map(|m| m.is_dir()).unwrap_or(false);
    if is_dir {
        symlink_dir(target, to)
    } else {
        symlink_file(target, to)
    }
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::remove_file(path),
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Identical to `remove_path` today (both branch on `symlink_metadata`),
/// but kept as a distinct name at the symlink-replacement call sites so
/// future readers can see "we explicitly do not want to follow the link
/// at this point" without re-deriving it from `remove_path`'s body.
fn remove_path_no_follow(path: &Path) -> std::io::Result<()> {
    remove_path(path)
}

fn finalize_probation_timeout(probation: &mut BootProbation) {
    probation.probation_secs = Some(probation_timeout().as_secs());
    if probation.log_tail.is_none() {
        probation.log_tail = collect_log_tail(&probation.data_dir);
    }
}

fn rollback_report_from_probation(
    probation: &BootProbation,
    restored: bool,
    error: Option<String>,
) -> BootRollbackReport {
    BootRollbackReport {
        failed_version: probation.failed_version.clone(),
        previous_version: probation.previous_version.clone(),
        download_url: probation.download_url.clone(),
        restored,
        error,
        failure_stage: probation.latest_stage.clone(),
        probation_secs: probation.probation_secs,
        log_tail: probation.log_tail.clone(),
    }
}

fn rollback_report_message(report: &BootRollbackReport) -> String {
    let reason = rollback_failure_reason(report);
    let action = if report.restored {
        format!("Aethon restored {}.", report.previous_version)
    } else {
        format!(
            "Aethon could not restore {}. Download the previous release from {}.",
            report.previous_version, report.download_url
        )
    };
    let mut message = format!(
        "{} {}\n\nPlease report this at https://github.com/utensils/aethon/issues.",
        reason, action
    );
    if !report.restored {
        let error = report.error.as_deref().unwrap_or("Unknown rollback error");
        message.push_str(&format!("\n\nRollback error: {error}"));
    }
    message
}

fn rollback_failure_reason(report: &BootRollbackReport) -> String {
    let timeout_secs = report.probation_secs.unwrap_or(DEFAULT_PROBATION_SECS);
    let detail = report
        .failure_stage
        .as_ref()
        .and_then(|stage| stage.detail.as_deref())
        .filter(|value| !value.is_empty());
    match report.failure_stage.as_ref().map(|stage| &stage.stage) {
        None | Some(BootStage::ProcessStarted) | Some(BootStage::WebviewCreated) => format!(
            "Aethon {} couldn't display its interface within {timeout_secs}s after the update.",
            report.failed_version
        ),
        Some(BootStage::ReactMounted) => format!(
            "Aethon {} displayed its interface but didn't finish startup within {timeout_secs}s.",
            report.failed_version
        ),
        Some(BootStage::InitialDataLoading) => format!(
            "Aethon {} took longer than {timeout_secs}s to finish loading after the update.",
            report.failed_version
        ),
        Some(BootStage::InitialDataFailed) => {
            if let Some(detail) = detail {
                format!(
                    "Aethon {} couldn't finish loading after the update: {detail}.",
                    report.failed_version
                )
            } else {
                format!(
                    "Aethon {} couldn't finish loading after the update.",
                    report.failed_version
                )
            }
        }
    }
}

fn clean_stage_detail(detail: String) -> Option<String> {
    let trimmed = detail.trim();
    if trimmed.is_empty() {
        return None;
    }
    const MAX_DETAIL_CHARS: usize = 500;
    Some(trimmed.chars().take(MAX_DETAIL_CHARS).collect())
}

fn apply_boot_stage(
    probation: &mut BootProbation,
    stage: BootStage,
    detail: Option<String>,
) -> bool {
    let should_update = probation
        .latest_stage
        .as_ref()
        .is_none_or(|current| boot_stage_rank(&stage) >= boot_stage_rank(&current.stage));
    if !should_update {
        return false;
    }

    probation.latest_stage = Some(BootStageRecord {
        stage,
        detail: detail.and_then(clean_stage_detail),
        recorded_at: chrono::Utc::now().to_rfc3339(),
    });
    true
}

fn boot_stage_rank(stage: &BootStage) -> u8 {
    match stage {
        BootStage::ProcessStarted => 0,
        BootStage::WebviewCreated => 1,
        BootStage::ReactMounted => 2,
        BootStage::InitialDataLoading => 3,
        BootStage::InitialDataFailed => 4,
    }
}

fn collect_log_tail(data_dir: &Path) -> Option<String> {
    let log_dir = data_dir.join("logs");
    if !log_dir.is_dir() {
        return None;
    }
    let latest = latest_log_file(&log_dir)?;
    read_file_tail(&latest, LOG_TAIL_BYTES).ok()
}

fn latest_log_file(log_dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(log_dir).ok()?;
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            // `tracing-appender` daily rotation produces filenames like
            // `aethon.2026-05-26` (no trailing `.log`) on the Rust side
            // and `bridge.YYYY-MM-DD.log` on the bun side. Accept both;
            // the most recently modified entry wins regardless of suffix.
            if !(name.starts_with("aethon.") || name.starts_with("bridge.")) {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn read_file_tail(path: &Path, max_bytes: u64) -> Result<String, std::io::Error> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_probation_path(path: &Path) -> Result<BootProbation, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read boot probation {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse boot probation {}: {e}", path.display()))
}

fn write_probation(data_dir: &Path, probation: &BootProbation) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("create data dir {}: {e}", data_dir.display()))?;
    write_json_atomically(&sentinel_path(data_dir), probation)
}

fn read_report_path(path: &Path) -> Result<BootRollbackReport, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read boot rollback report {}: {e}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("parse boot rollback report {}: {e}", path.display()))
}

fn write_report(data_dir: &Path, report: &BootRollbackReport) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("create data dir {}: {e}", data_dir.display()))?;
    write_json_atomically(&report_path(data_dir), report)
}

fn result_path_parent(sentinel: &Path) -> PathBuf {
    sentinel
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let body = serde_json::to_vec_pretty(value).map_err(|e| format!("serialize json: {e}"))?;
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    #[cfg(windows)]
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("replace {}: {e}", path.display()))?;
    }
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), path.display()))
}

fn sanitize_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use tempfile::tempdir;

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn sample_probation(data_dir: &Path, backup_path: Option<PathBuf>) -> BootProbation {
        BootProbation {
            status: ProbationStatus::Pending,
            failed_version: "0.4.0".to_string(),
            previous_version: "0.3.3".to_string(),
            download_url: "https://example.invalid/download".to_string(),
            install_kind: InstallKind::MacApp,
            target_path: data_dir.join("Aethon.app"),
            executable_path: data_dir.join("Aethon.app/Contents/MacOS/aethon"),
            backup_path,
            backup_error: None,
            attempts: 0,
            data_dir: data_dir.to_path_buf(),
            created_at: "2026-05-26T00:00:00Z".to_string(),
            latest_stage: None,
            probation_secs: None,
            log_tail: None,
        }
    }

    #[test]
    fn writes_and_reads_probation_sentinel() {
        let tmp = tempdir().unwrap();
        let probation = sample_probation(tmp.path(), None);
        write_probation(tmp.path(), &probation).unwrap();

        let got = read_probation_path(&sentinel_path(tmp.path())).unwrap();
        assert_eq!(got.failed_version, "0.4.0");
        assert_eq!(got.previous_version, "0.3.3");
        assert_eq!(got.status, ProbationStatus::Pending);
    }

    #[test]
    fn acknowledge_clears_sentinel_and_cancels_state() {
        let tmp = tempdir().unwrap();
        let state = Arc::new(BootProbationState::default());
        write_probation(tmp.path(), &sample_probation(tmp.path(), None)).unwrap();

        acknowledge_boot(tmp.path(), &state).unwrap();

        assert!(state.is_acknowledged());
        assert!(!sentinel_path(tmp.path()).exists());
    }

    #[test]
    fn restore_backup_replaces_failed_install() {
        let tmp = tempdir().unwrap();
        let failed = tmp.path().join("failed");
        let backup = tmp.path().join("backup");
        std::fs::create_dir_all(&failed).unwrap();
        std::fs::write(failed.join("app"), "broken").unwrap();
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(backup.join("app"), "restored").unwrap();

        let mut probation = sample_probation(tmp.path(), Some(backup));
        probation.target_path = failed.clone();
        probation.executable_path = failed.join("app");

        restore_backup(&probation).unwrap();

        assert_eq!(
            std::fs::read_to_string(failed.join("app")).unwrap(),
            "restored"
        );
    }

    #[test]
    fn restore_without_backup_fails_without_looping() {
        let tmp = tempdir().unwrap();
        let probation = sample_probation(tmp.path(), None);

        let err = restore_backup(&probation).unwrap_err();

        assert!(err.contains("No previous install backup"));
    }

    #[test]
    fn backup_helper_copies_macos_app_bundle() {
        let _guard = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let source_dir = tmp.path().join("Aethon.app");
        std::fs::create_dir_all(source_dir.join("Contents/MacOS")).unwrap();
        std::fs::write(source_dir.join("Contents/MacOS/aethon"), "app").unwrap();
        let target = InstallTarget {
            kind: InstallKind::MacApp,
            target_path: source_dir,
            executable_path: tmp.path().join("Aethon.app/Contents/MacOS/aethon"),
            is_dir: true,
        };

        let backup = create_backup(&data_dir, &target, "test-version")
            .unwrap()
            .unwrap();

        assert!(backup.join("Contents/MacOS/aethon").exists());
    }

    #[test]
    fn rollback_failed_status_is_serialized_for_no_loop_state() {
        let tmp = tempdir().unwrap();
        let mut probation = sample_probation(tmp.path(), None);
        probation.status = ProbationStatus::RollbackFailed;
        write_probation(tmp.path(), &probation).unwrap();

        let raw = std::fs::read_to_string(sentinel_path(tmp.path())).unwrap();

        assert!(raw.contains("\"status\": \"rollback_failed\""));
    }

    #[test]
    fn writing_probation_replaces_existing_sentinel() {
        let tmp = tempdir().unwrap();
        let mut probation = sample_probation(tmp.path(), None);
        write_probation(tmp.path(), &probation).unwrap();

        probation.status = ProbationStatus::RollbackInProgress;
        probation.attempts = 2;
        write_probation(tmp.path(), &probation).unwrap();

        let got = read_probation_path(&sentinel_path(tmp.path())).unwrap();
        assert_eq!(got.status, ProbationStatus::RollbackInProgress);
        assert_eq!(got.attempts, 2);
    }

    #[test]
    fn record_boot_stage_persists_latest_progress() {
        let tmp = tempdir().unwrap();
        write_probation(tmp.path(), &sample_probation(tmp.path(), None)).unwrap();

        record_boot_stage(tmp.path(), BootStage::ReactMounted, None).unwrap();
        record_boot_stage(
            tmp.path(),
            BootStage::InitialDataFailed,
            Some("bridge stalled".to_string()),
        )
        .unwrap();

        let got = read_probation_path(&sentinel_path(tmp.path())).unwrap();
        let stage = got.latest_stage.unwrap();
        assert_eq!(stage.stage, BootStage::InitialDataFailed);
        assert_eq!(stage.detail.as_deref(), Some("bridge stalled"));
    }

    #[test]
    fn record_boot_stage_ignores_older_late_arrivals() {
        let tmp = tempdir().unwrap();
        write_probation(tmp.path(), &sample_probation(tmp.path(), None)).unwrap();

        record_boot_stage(tmp.path(), BootStage::InitialDataLoading, None).unwrap();
        record_boot_stage(tmp.path(), BootStage::ReactMounted, None).unwrap();

        let got = read_probation_path(&sentinel_path(tmp.path())).unwrap();
        assert_eq!(
            got.latest_stage.as_ref().map(|stage| &stage.stage),
            Some(&BootStage::InitialDataLoading)
        );
    }

    #[test]
    fn record_boot_stage_reports_noop_when_sentinel_is_absent() {
        let tmp = tempdir().unwrap();

        let changed = record_boot_stage(tmp.path(), BootStage::ReactMounted, None).unwrap();

        assert!(!changed);
    }

    #[test]
    fn apply_boot_stage_does_not_regress_existing_progress() {
        let tmp = tempdir().unwrap();
        let mut probation = sample_probation(tmp.path(), None);

        assert!(apply_boot_stage(
            &mut probation,
            BootStage::InitialDataLoading,
            None
        ));
        assert!(!apply_boot_stage(
            &mut probation,
            BootStage::WebviewCreated,
            None
        ));

        assert_eq!(
            probation.latest_stage.as_ref().map(|stage| &stage.stage),
            Some(&BootStage::InitialDataLoading)
        );
    }

    #[test]
    fn rollback_report_carries_stage_timeout_and_log_tail() {
        let tmp = tempdir().unwrap();
        let mut probation = sample_probation(tmp.path(), None);
        probation.latest_stage = Some(BootStageRecord {
            stage: BootStage::InitialDataLoading,
            detail: None,
            recorded_at: "2026-05-26T21:22:02Z".to_string(),
        });
        probation.probation_secs = Some(42);
        probation.log_tail = Some("recent updater log".to_string());

        let report = rollback_report_from_probation(&probation, true, None);

        assert_eq!(
            report.failure_stage.as_ref().map(|stage| &stage.stage),
            Some(&BootStage::InitialDataLoading)
        );
        assert_eq!(report.probation_secs, Some(42));
        assert_eq!(report.log_tail.as_deref(), Some("recent updater log"));
    }

    #[test]
    fn rollback_message_describes_initial_data_failure() {
        let report = BootRollbackReport {
            failed_version: "0.4.0".to_string(),
            previous_version: "0.3.3".to_string(),
            download_url: "https://example.invalid/download".to_string(),
            restored: true,
            error: None,
            failure_stage: Some(BootStageRecord {
                stage: BootStage::InitialDataFailed,
                detail: Some("bridge stalled".to_string()),
                recorded_at: "2026-05-26T21:22:02Z".to_string(),
            }),
            probation_secs: Some(20),
            log_tail: None,
        };

        let message = rollback_report_message(&report);

        assert!(message.contains("couldn't finish loading"));
        assert!(message.contains("bridge stalled"));
        assert!(message.contains("Aethon restored 0.3.3"));
    }

    #[test]
    fn rollback_message_keeps_rollback_execution_error_separate() {
        let report = BootRollbackReport {
            failed_version: "0.4.0".to_string(),
            previous_version: "0.3.3".to_string(),
            download_url: "https://example.invalid/download".to_string(),
            restored: false,
            error: Some("backup path is missing".to_string()),
            failure_stage: Some(BootStageRecord {
                stage: BootStage::WebviewCreated,
                detail: None,
                recorded_at: "2026-05-26T21:22:02Z".to_string(),
            }),
            probation_secs: Some(20),
            log_tail: Some("log tail".to_string()),
        };

        let message = rollback_report_message(&report);

        assert!(message.contains("couldn't display its interface"));
        assert!(message.contains("Download the previous release"));
        assert!(message.contains("Rollback error: backup path is missing"));
    }

    #[test]
    fn latest_log_file_filters_aethon_or_bridge_daily_logs() {
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join("other.2026-05-20.log"), "wrong prefix").unwrap();
        let expected = tmp.path().join("aethon.2026-05-20");
        std::fs::write(&expected, "daily log").unwrap();
        // bridge.YYYY-MM-DD.log: should also match.
        let bridge = tmp.path().join("bridge.2026-05-25.log");
        std::fs::write(&bridge, "bridge log").unwrap();

        let got = latest_log_file(tmp.path()).expect("must find a file");
        assert!(
            got == expected || got == bridge,
            "expected aethon. or bridge. prefix, got {got:?}"
        );
    }

    #[test]
    fn read_file_tail_returns_bounded_suffix() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("aethon.2026-05-26.log");
        std::fs::write(&path, "0123456789").unwrap();

        assert_eq!(read_file_tail(&path, 4).unwrap(), "6789");
        assert_eq!(read_file_tail(&path, 64).unwrap(), "0123456789");
    }

    /// Regression: macOS `.app` bundles routinely contain framework
    /// symlinks like `Foo.framework/Foo -> Versions/Current/Foo`. Plain
    /// `metadata().is_dir()` hits the non-dir branch on a symlink, and
    /// `std::fs::copy` can't copy a symlink-to-directory (`Is a
    /// directory`). Lock that down: symlinks survive a backup → restore
    /// roundtrip.
    #[cfg(unix)]
    #[test]
    fn copy_path_preserves_symlinks_for_macos_frameworks() {
        use std::os::unix::fs::symlink;
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("Source.app");
        let frameworks = src.join("Contents/Frameworks/Foo.framework");
        let versions = frameworks.join("Versions/A");
        std::fs::create_dir_all(&versions).unwrap();
        std::fs::write(versions.join("Foo"), b"binary").unwrap();
        symlink("A", frameworks.join("Versions/Current")).unwrap();
        symlink("Versions/Current/Foo", frameworks.join("Foo")).unwrap();

        let dst = tmp.path().join("Backup.app");
        copy_path(&src, &dst).unwrap();

        let dir_link = dst.join("Contents/Frameworks/Foo.framework/Versions/Current");
        let file_link = dst.join("Contents/Frameworks/Foo.framework/Foo");
        assert!(
            std::fs::symlink_metadata(&dir_link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "Versions/Current must remain a symlink"
        );
        assert_eq!(std::fs::read_link(&dir_link).unwrap(), Path::new("A"));
        assert!(
            std::fs::symlink_metadata(&file_link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "Foo entry must remain a symlink"
        );
        assert_eq!(
            std::fs::read_link(&file_link).unwrap(),
            Path::new("Versions/Current/Foo")
        );
        // The link's target must still resolve through the restored bundle.
        assert_eq!(std::fs::read(&file_link).unwrap(), b"binary");
    }

    #[test]
    fn create_backup_prunes_older_siblings() {
        let _guard = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        // Pre-existing stale generation we expect to be cleaned up.
        let stale = updates_previous_dir(&data_dir, "0.1.0");
        std::fs::create_dir_all(stale.join("Aethon.app/Contents/MacOS")).unwrap();
        std::fs::write(stale.join("Aethon.app/Contents/MacOS/aethon"), b"old").unwrap();

        let source_dir = tmp.path().join("Source.app");
        std::fs::create_dir_all(source_dir.join("Contents/MacOS")).unwrap();
        std::fs::write(source_dir.join("Contents/MacOS/aethon"), b"new").unwrap();
        let target = InstallTarget {
            kind: InstallKind::MacApp,
            target_path: source_dir.clone(),
            executable_path: source_dir.join("Contents/MacOS/aethon"),
            is_dir: true,
        };

        let backup = create_backup(&data_dir, &target, "0.3.3").unwrap().unwrap();
        assert!(backup.exists(), "fresh backup should exist");
        assert!(!stale.exists(), "stale {} should be GC'd", stale.display());
    }

    #[test]
    fn probation_timeout_clamps_env_override() {
        let _guard = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        // SAFETY: env_lock serialises env mutations across tests in this
        // module so concurrent threads cannot observe a half-written
        // global.
        unsafe { std::env::set_var("AETHON_BOOT_PROBATION_SECS", "0") };
        assert!(probation_timeout() >= Duration::from_secs(MIN_PROBATION_SECS));
        unsafe { std::env::set_var("AETHON_BOOT_PROBATION_SECS", "9999") };
        assert!(probation_timeout() <= Duration::from_secs(MAX_PROBATION_SECS));
        unsafe { std::env::set_var("AETHON_BOOT_PROBATION_SECS", "garbage") };
        assert_eq!(
            probation_timeout(),
            Duration::from_secs(DEFAULT_PROBATION_SECS)
        );
        unsafe { std::env::remove_var("AETHON_BOOT_PROBATION_SECS") };
    }

    #[test]
    fn is_pid_alive_reports_self_alive() {
        assert!(
            is_pid_alive(std::process::id()),
            "current process must register as alive"
        );
    }

    #[cfg(unix)]
    #[test]
    fn remove_path_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let tmp = tempdir().unwrap();
        let target_dir = tmp.path().join("target_dir");
        std::fs::create_dir_all(&target_dir).unwrap();
        std::fs::write(target_dir.join("keepme"), b"keep").unwrap();
        let link = tmp.path().join("link");
        symlink(&target_dir, &link).unwrap();

        remove_path(&link).unwrap();

        assert!(!link.exists(), "the symlink itself should be gone");
        assert!(
            target_dir.join("keepme").exists(),
            "the link's target must not be touched"
        );
    }
}
