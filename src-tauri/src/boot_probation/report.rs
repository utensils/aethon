//! Rollback report collection and user-facing formatting: build the
//! report from a probation record, render the dialog message, and gather
//! a bounded tail of the most recent log file.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use super::monitor::DEFAULT_PROBATION_SECS;
use super::schema::{BootProbation, BootRollbackReport, BootStage, read_report_path, report_path};

const LOG_TAIL_BYTES: u64 = 16 * 1024;

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

pub(super) fn rollback_report_from_probation(
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

pub(super) fn rollback_report_message(report: &BootRollbackReport) -> String {
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

pub(super) fn collect_log_tail(data_dir: &Path) -> Option<String> {
    let log_dir = data_dir.join("logs");
    if !log_dir.is_dir() {
        return None;
    }
    let latest = latest_log_file(&log_dir)?;
    read_file_tail(&latest, LOG_TAIL_BYTES).ok()
}

pub(super) fn latest_log_file(log_dir: &Path) -> Option<PathBuf> {
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

pub(super) fn read_file_tail(path: &Path, max_bytes: u64) -> Result<String, std::io::Error> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
