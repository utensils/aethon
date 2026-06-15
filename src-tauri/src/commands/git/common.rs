use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use crate::env;

pub(crate) const GIT_OPTIONAL_LOCKS_ENV: &str = "GIT_OPTIONAL_LOCKS";
pub(crate) const GIT_OPTIONAL_LOCKS_DISABLED: &str = "0";
pub(crate) const GIT_INDEX_LOCKED_MESSAGE: &str = "git index locked; skipping read-only refresh";
const INDEX_LOCK_TRANSIENT_WINDOW: Duration = Duration::from_secs(300);

/// Build a read-only `git` command that cannot take Git's optional index lock.
///
/// Background UI refreshes must observe repository state without refreshing the
/// index stat cache; otherwise they can race user-owned operations and create or
/// contend on `.git/index.lock`.
pub(crate) fn read_only_git_command() -> Command {
    let mut command = env::command("git");
    disable_optional_locks(&mut command);
    command
}

/// Build a read-only `gh` command. The GitHub CLI may inspect local repository
/// metadata under the hood, so pass the same optional-lock guard through its
/// environment for dashboard/status queries.
pub(crate) fn read_only_gh_command() -> Command {
    let mut command = env::command("gh");
    disable_optional_locks(&mut command);
    command
}

/// Tokio variant of [`read_only_gh_command`].
pub(crate) fn read_only_tokio_gh_command() -> tokio::process::Command {
    let mut command = env::tokio_command("gh");
    command.env(GIT_OPTIONAL_LOCKS_ENV, GIT_OPTIONAL_LOCKS_DISABLED);
    command
}

pub(crate) fn fail_if_index_locked(dir: &Path) -> Result<(), String> {
    if git_index_lock_exists(dir) {
        Err(GIT_INDEX_LOCKED_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

fn disable_optional_locks(command: &mut Command) {
    command.env(GIT_OPTIONAL_LOCKS_ENV, GIT_OPTIONAL_LOCKS_DISABLED);
}

fn git_index_lock_exists(dir: &Path) -> bool {
    read_only_git_dir(dir).is_some_and(|git_dir| {
        let lock = git_dir.join("index.lock");
        lock.exists() && index_lock_is_recent(&lock, SystemTime::now())
    })
}

fn index_lock_is_recent(lock: &Path, now: SystemTime) -> bool {
    let Ok(modified) = lock.metadata().and_then(|m| m.modified()) else {
        return true;
    };
    now.duration_since(modified)
        .map(|age| age <= INDEX_LOCK_TRANSIENT_WINDOW)
        .unwrap_or(true)
}

fn read_only_git_dir(dir: &Path) -> Option<PathBuf> {
    let out = read_only_git_command()
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--path-format=absolute", "--git-dir"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    Some(path.canonicalize().unwrap_or(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn command_env(command: &Command, key: &str) -> Option<String> {
        command
            .get_envs()
            .find(|(k, _)| *k == OsStr::new(key))
            .and_then(|(_, v)| v.map(|v| v.to_string_lossy().to_string()))
    }

    #[test]
    fn read_only_git_command_disables_optional_locks() {
        let command = read_only_git_command();

        assert_eq!(
            command_env(&command, GIT_OPTIONAL_LOCKS_ENV).as_deref(),
            Some(GIT_OPTIONAL_LOCKS_DISABLED)
        );
    }

    #[test]
    fn read_only_gh_command_propagates_optional_lock_guard_to_child_git() {
        let command = read_only_gh_command();

        assert_eq!(
            command_env(&command, GIT_OPTIONAL_LOCKS_ENV).as_deref(),
            Some(GIT_OPTIONAL_LOCKS_DISABLED)
        );
    }

    #[test]
    fn stale_index_lock_is_not_treated_as_active() {
        let lock = tempfile::NamedTempFile::new().unwrap();
        let later = SystemTime::now() + INDEX_LOCK_TRANSIENT_WINDOW + Duration::from_secs(1);

        assert!(!index_lock_is_recent(lock.path(), later));
    }

    #[test]
    fn recent_index_lock_is_treated_as_active() {
        let lock = tempfile::NamedTempFile::new().unwrap();
        let now = SystemTime::now();

        assert!(index_lock_is_recent(lock.path(), now));
    }
}
