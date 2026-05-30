//! Pre-install backup engine: copy the currently-installed bundle aside
//! before the updater overwrites it, prune stale generations, and restore
//! the backup over a failed install on rollback.

use std::path::{Path, PathBuf};

use super::detect::detect_install_target;
use super::schema::updates_previous_dir;
use super::schema::{BootProbation, InstallKind, InstallTarget, ProbationStatus, write_probation};

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

pub(super) fn restore_backup(probation: &BootProbation) -> Result<(), String> {
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

pub(super) fn create_backup(
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
pub(super) fn copy_path(from: &Path, to: &Path) -> std::io::Result<()> {
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

pub(super) fn remove_path(path: &Path) -> std::io::Result<()> {
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
