//! State/sentinel/report data types, their JSON read/write, and the
//! path-layout helpers shared across the boot-probation modules.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub(super) const SENTINEL_FILE: &str = "boot-probation.json";
pub(super) const REPORT_FILE: &str = "boot-rollback-report.json";
pub(super) static PROBATION_FILE_LOCK: Mutex<()> = Mutex::new(());

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
pub(super) struct InstallTarget {
    pub(super) kind: InstallKind,
    pub(super) target_path: PathBuf,
    pub(super) executable_path: PathBuf,
    pub(super) is_dir: bool,
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

pub(super) fn read_probation_path(path: &Path) -> Result<BootProbation, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read boot probation {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse boot probation {}: {e}", path.display()))
}

pub(super) fn write_probation(data_dir: &Path, probation: &BootProbation) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("create data dir {}: {e}", data_dir.display()))?;
    write_json_atomically(&sentinel_path(data_dir), probation)
}

pub(super) fn read_report_path(path: &Path) -> Result<BootRollbackReport, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read boot rollback report {}: {e}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("parse boot rollback report {}: {e}", path.display()))
}

pub(super) fn write_report(data_dir: &Path, report: &BootRollbackReport) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("create data dir {}: {e}", data_dir.display()))?;
    write_json_atomically(&report_path(data_dir), report)
}

pub(super) fn result_path_parent(sentinel: &Path) -> PathBuf {
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
