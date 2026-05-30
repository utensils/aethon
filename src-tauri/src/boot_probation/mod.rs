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

mod backup;
mod detect;
mod monitor;
mod report;
mod rollback;
mod schema;

// External surface consumed by `lib.rs` (setup()/run()) and
// `commands/updater.rs` / `updater_state.rs`. Re-exported so callers
// keep resolving `crate::boot_probation::X`.
pub(crate) use backup::prepare_for_update;
pub(crate) use monitor::{
    BootProbationState, acknowledge_boot, has_pending_probation, record_boot_stage, start_monitor,
};
pub(crate) use report::show_pending_report;
pub(crate) use rollback::run_helper_from_args;
pub(crate) use schema::BootStage;

#[cfg(test)]
mod tests {
    use super::backup::{copy_path, create_backup, remove_path, restore_backup};
    use super::monitor::{
        BootProbationState, DEFAULT_PROBATION_SECS, MAX_PROBATION_SECS, MIN_PROBATION_SECS,
        acknowledge_boot, apply_boot_stage, has_pending_probation, probation_timeout,
        record_boot_stage,
    };
    use super::report::{
        latest_log_file, read_file_tail, rollback_report_from_probation, rollback_report_message,
    };
    use super::rollback::is_pid_alive;
    use super::schema::{
        BootProbation, BootRollbackReport, BootStage, BootStageRecord, InstallKind, InstallTarget,
        ProbationStatus, read_probation_path, sentinel_path, updates_previous_dir, write_probation,
    };
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;
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
    fn pending_probation_marks_post_update_launch() {
        let tmp = tempdir().unwrap();
        assert!(!has_pending_probation(tmp.path()));

        let mut probation = sample_probation(tmp.path(), None);
        write_probation(tmp.path(), &probation).unwrap();
        assert!(has_pending_probation(tmp.path()));

        probation.status = ProbationStatus::RollbackInProgress;
        write_probation(tmp.path(), &probation).unwrap();
        assert!(!has_pending_probation(tmp.path()));
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
