//! Rollback engine and the self-relaunching helper subprocess. The
//! helper waits for the failed parent to die, restores the backup, and
//! relaunches the previous build.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::backup::restore_backup;
use super::report::rollback_report_from_probation;
use super::schema::{
    BootProbation, ProbationStatus, read_probation_path, result_path_parent, write_probation,
    write_report,
};

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

fn relaunch(probation: &BootProbation) -> Result<(), String> {
    std::process::Command::new(&probation.executable_path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("relaunch {}: {e}", probation.executable_path.display()))
}

pub(super) fn spawn_rollback_helper(sentinel: &Path) -> Result<(), String> {
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
pub(super) fn is_pid_alive(pid: u32) -> bool {
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if r == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
pub(super) fn is_pid_alive(_pid: u32) -> bool {
    false
}
