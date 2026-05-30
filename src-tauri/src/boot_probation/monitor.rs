//! Boot-stage staging/ack and the probation timer. Owns the in-memory
//! `BootProbationState` cancellation handle plus the attempt-counting
//! arm/finalize machinery driven from `setup()`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Notify;

use super::report::{collect_log_tail, rollback_report_from_probation};
use super::rollback::spawn_rollback_helper;
use super::schema::{
    BootProbation, BootStage, BootStageRecord, PROBATION_FILE_LOCK, ProbationStatus,
    read_probation_path, sentinel_path, write_probation, write_report,
};

pub(super) const DEFAULT_PROBATION_SECS: u64 = 20;
/// Hard floor / ceiling for the env-var override. A 0-second probation
/// would never let `boot_ok` race the timer; a 2-minute probation makes
/// the rollback feel broken to users on the unhappy path.
pub(super) const MIN_PROBATION_SECS: u64 = 1;
pub(super) const MAX_PROBATION_SECS: u64 = 120;
/// After this many recorded launch attempts on the same sentinel, we
/// stop arming the rollback. The user has already booted past the
/// probation window once (otherwise we'd have rolled back on attempt 1)
/// — that's the strongest "this build runs" signal we can collect
/// without IPC. Force-quits during the probation window otherwise loop
/// the user back to the rolled-back version forever.
const MAX_PROBATION_ATTEMPTS: u32 = 2;

pub(super) fn probation_timeout() -> Duration {
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

    pub(super) fn is_acknowledged(&self) -> bool {
        self.acknowledged.load(Ordering::SeqCst)
    }
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

/// True when the current launch is part of the post-update probation
/// window. Setup uses this to restore Aethon to the foreground after
/// the updater relaunches the newly-installed app.
pub fn has_pending_probation(data_dir: &Path) -> bool {
    let path = sentinel_path(data_dir);
    let _guard = PROBATION_FILE_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    read_probation_path(&path)
        .map(|probation| matches!(probation.status, ProbationStatus::Pending))
        .unwrap_or(false)
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

fn finalize_probation_timeout(probation: &mut BootProbation) {
    probation.probation_secs = Some(probation_timeout().as_secs());
    if probation.log_tail.is_none() {
        probation.log_tail = collect_log_tail(&probation.data_dir);
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

pub(super) fn apply_boot_stage(
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
