use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::State;

use crate::env;

const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const FETCH_DEDUP_WINDOW: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct GitFetchState {
    attempts: Mutex<HashMap<PathBuf, Instant>>,
}

/// Read minimal git status for a project directory. Used by the
/// sidebar to surface a branch chip + dirty dot per project. Returns
/// `None` when the path isn't a git repository so the caller can
/// gracefully render nothing instead of bouncing through an error path.
///
/// The call shells out to `git` because reimplementing the parts we
/// need (HEAD ref read, porcelain status, upstream tracking) duplicates
/// the corner cases git already handles correctly (worktrees, detached
/// HEAD, packed refs, submodules). We only run two git commands:
/// `symbolic-ref --short HEAD` for the branch (or `rev-parse --short
/// HEAD` when detached) and `status --porcelain=v1 --branch` for the
/// dirty/ahead/behind triple. Total wall time on a clean repo is well
/// under 50ms; we cache results on the frontend so the sidebar's
/// per-project poll runs at a sane cadence.
#[derive(serde::Serialize, Default)]
pub struct GitStatus {
    branch: Option<String>,
    dirty: bool,
    ahead: u32,
    behind: u32,
}

/// Best-effort refresh of remote-tracking refs for a project. Returns `true`
/// when a fetch command actually ran to completion (even if git exited nonzero
/// after partially updating refs), `false` for non-repositories, missing `git`,
/// duplicate worktree fetches that were recently attempted, or timeouts. The
/// frontend treats this as a background maintenance task and must never blank
/// existing status chips because it failed.
#[tauri::command]
pub async fn git_fetch_all(
    project_path: String,
    state: State<'_, GitFetchState>,
) -> Result<bool, String> {
    git_fetch_all_inner(project_path, state.inner()).await
}

async fn git_fetch_all_inner(project_path: String, state: &GitFetchState) -> Result<bool, String> {
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Ok(false);
    }
    if !is_inside_work_tree(&dir) {
        return Ok(false);
    }

    let key = git_common_dir(&dir).unwrap_or_else(|| dir.canonicalize().unwrap_or(dir.clone()));
    if !state.reserve_attempt(key) {
        return Ok(false);
    }

    // `--prune` only removes stale remote-tracking refs; it does not delete
    // local branches. Keeping those refs accurate makes ahead/behind chips
    // reflect deleted/renamed upstream branches instead of preserving ghosts.
    let mut cmd = env::tokio_command("git");
    cmd.arg("-C")
        .arg(&dir)
        .args(["fetch", "--all", "--prune", "--quiet"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .kill_on_drop(true);
    let out = tokio::time::timeout(FETCH_TIMEOUT, cmd.output()).await;
    Ok(matches!(out, Ok(Ok(_))))
}

fn is_inside_work_tree(dir: &Path) -> bool {
    let inside = env::command("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output();
    match inside {
        Ok(o) => o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true",
        Err(_) => false,
    }
}

fn git_common_dir(dir: &Path) -> Option<PathBuf> {
    let out = env::command("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
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

impl GitFetchState {
    fn reserve_attempt(&self, key: PathBuf) -> bool {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().unwrap_or_else(|e| e.into_inner());
        attempts.retain(|_, last| now.duration_since(*last) < FETCH_DEDUP_WINDOW);
        if attempts
            .get(&key)
            .is_some_and(|last| now.duration_since(*last) < FETCH_DEDUP_WINDOW)
        {
            return false;
        }
        attempts.insert(key, now);
        true
    }
}

/// One per-file worktree change as reported by `git status --porcelain`.
/// Paths are normalized to be relative to the active project/worktree root
/// passed by the frontend (not necessarily the repository top-level).
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatusEntry {
    pub path: String,
    pub status: &'static str,
    pub original_path: Option<String>,
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<Option<GitStatus>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Ok(None);
    }
    // Quick presence check — `git rev-parse --is-inside-work-tree`.
    // Saves spawning the porcelain pass on a non-git directory.
    let inside = env::command("git")
        .arg("-C")
        .arg(&dir)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output();
    let inside_ok = match inside {
        Ok(o) => o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true",
        Err(_) => false,
    };
    if !inside_ok {
        return Ok(None);
    }
    // Branch: prefer the symbolic name. Falls back to a short SHA on
    // detached HEAD so the chip still says something useful.
    let branch_out = env::command("git")
        .arg("-C")
        .arg(&dir)
        .args(["symbolic-ref", "--short", "HEAD"])
        .output()
        .ok();
    let branch = match branch_out {
        Some(o) if o.status.success() => {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        }
        _ => env::command("git")
            .arg("-C")
            .arg(&dir)
            .args(["rev-parse", "--short", "HEAD"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()),
    };
    // Porcelain v1 with --branch gives us:
    //   ## branch...origin/branch [ahead 2, behind 1]
    //   <X><Y> path
    //   …
    // The header line is parsed for ahead/behind (when an upstream is
    // configured). Any subsequent line means the worktree is dirty.
    let porcelain = env::command("git")
        .arg("-C")
        .arg(&dir)
        .args(["status", "--porcelain=v1", "--branch"])
        .output()
        .map_err(|e| format!("git status: {e}"))?;
    if !porcelain.status.success() {
        return Ok(Some(GitStatus {
            branch,
            ..Default::default()
        }));
    }
    let text = String::from_utf8_lossy(&porcelain.stdout);
    let mut dirty = false;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // Optional `[ahead N, behind M]` tail in any combination.
            if let Some(start) = rest.find('[')
                && let Some(end) = rest[start..].find(']')
            {
                let inner = &rest[start + 1..start + end];
                for part in inner.split(',') {
                    let part = part.trim();
                    if let Some(n) = part.strip_prefix("ahead ") {
                        ahead = n.trim().parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
        } else if !line.is_empty() {
            // Any non-header line = a tracked / untracked change.
            dirty = true;
        }
    }
    Ok(Some(GitStatus {
        branch,
        dirty,
        ahead,
        behind,
    }))
}

/// Return per-file Git decorations for the active file tree root. `None`
/// means the directory is not inside a Git worktree; callers should render
/// the plain filesystem tree in that case.
#[tauri::command]
pub async fn git_file_status(root: String) -> Result<Option<Vec<GitFileStatusEntry>>, String> {
    let dir = PathBuf::from(&root);
    if !dir.is_dir() {
        return Ok(None);
    }

    let Some((repo_root, active_root)) = resolve_repo_and_active_root(&dir)? else {
        return Ok(None);
    };

    // `--porcelain=v1 -z` gives a stable, NUL-delimited format whose paths
    // are not quoted, so spaces and unusual characters do not need a fragile
    // line parser. `-- .` scopes the result to the active root when the user
    // opened a repository subdirectory as the project.
    let porcelain = env::command("git")
        .arg("-C")
        .arg(&active_root)
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--renames",
            "--",
            ".",
        ])
        .output()
        .map_err(|e| format!("git status: {e}"))?;
    if !porcelain.status.success() {
        return Ok(Some(Vec::new()));
    }

    let entries = parse_git_file_status_porcelain_z(&porcelain.stdout)
        .into_iter()
        .filter_map(|mut entry| {
            entry.path = path_relative_to_active_root(&repo_root, &active_root, &entry.path)?;
            entry.original_path = entry
                .original_path
                .as_deref()
                .and_then(|p| path_relative_to_active_root(&repo_root, &active_root, p));
            Some(entry)
        })
        .collect();
    Ok(Some(entries))
}

/// Resolve `(repo_root, active_root)` for a directory, both canonicalized so
/// path math against git output is stable. Returns `None` when `dir` is not
/// inside a git worktree, so callers can render the plain filesystem tree.
pub(crate) fn resolve_repo_and_active_root(
    dir: &Path,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let inside = env::command("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output();
    let inside_ok = match inside {
        Ok(o) => o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true",
        Err(_) => false,
    };
    if !inside_ok {
        return Ok(None);
    }

    let top_level = env::command("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("git rev-parse --show-toplevel: {e}"))?;
    if !top_level.status.success() {
        return Ok(None);
    }
    let repo_root_raw = PathBuf::from(
        String::from_utf8_lossy(&top_level.stdout)
            .trim()
            .to_string(),
    );
    let repo_root = repo_root_raw.canonicalize().unwrap_or(repo_root_raw);
    let active_root = dir
        .canonicalize()
        .map_err(|e| format!("root canonicalize {}: {e}", dir.display()))?;
    Ok(Some((repo_root, active_root)))
}

/// Return the git-ignored paths under the active file tree root, so the
/// frontend can grey them out. `None` means the directory is not a git
/// worktree. `--directory` collapses a wholly-ignored folder to a single
/// `node_modules/` entry instead of enumerating every file inside it, so the
/// result stays small even for large vendored trees. Paths are relative to
/// the active root and directories keep their trailing `/`.
#[tauri::command]
pub async fn git_ignored_paths(root: String) -> Result<Option<Vec<String>>, String> {
    let dir = PathBuf::from(&root);
    if !dir.is_dir() {
        return Ok(None);
    }

    let Some((_repo_root, active_root)) = resolve_repo_and_active_root(&dir)? else {
        return Ok(None);
    };

    // `--others --ignored --exclude-standard` lists only ignored entries; `-z`
    // keeps paths unquoted + NUL-delimited; `-- .` scopes to the active root
    // so a subdirectory-opened repo reports its own ignores, output relative
    // to that root.
    let output = env::command("git")
        .arg("-C")
        .arg(&active_root)
        .args([
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "--",
            ".",
        ])
        .output()
        .map_err(|e| format!("git ls-files: {e}"))?;
    if !output.status.success() {
        return Ok(Some(Vec::new()));
    }
    Ok(Some(parse_nul_paths(&output.stdout)))
}

/// Split a NUL-delimited byte stream (`-z` git output) into non-empty path
/// strings, lossily decoding any non-UTF-8 bytes.
pub(crate) fn parse_nul_paths(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).to_string())
        .collect()
}

pub(crate) fn path_relative_to_active_root(
    repo_root: &Path,
    active_root: &Path,
    git_path: &str,
) -> Option<String> {
    let abs = repo_root.join(git_path);
    let rel = abs.strip_prefix(active_root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() { None } else { Some(s) }
}

fn classify_git_status(x: u8, y: u8) -> Option<&'static str> {
    if x == b'!' && y == b'!' {
        return None;
    }
    if x == b'?' && y == b'?' {
        return Some("untracked");
    }
    if x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D') {
        return Some("conflicted");
    }
    if x == b'R' || y == b'R' {
        return Some("renamed");
    }
    if x == b'C' || y == b'C' {
        return Some("copied");
    }
    if x == b'D' || y == b'D' {
        return Some("deleted");
    }
    if x == b'A' || y == b'A' {
        return Some("added");
    }
    if x == b'M' || y == b'M' || x == b'T' || y == b'T' {
        return Some("modified");
    }
    if x != b' ' || y != b' ' {
        return Some("modified");
    }
    None
}

pub(crate) fn parse_git_file_status_porcelain_z(bytes: &[u8]) -> Vec<GitFileStatusEntry> {
    let mut out = Vec::new();
    let mut parts = bytes.split(|b| *b == 0).filter(|part| !part.is_empty());
    while let Some(record) = parts.next() {
        if record.len() < 4 {
            continue;
        }
        let x = record[0];
        let y = record[1];
        let Some(status) = classify_git_status(x, y) else {
            continue;
        };
        // Shape is `XY path`. In `-z` mode, rename/copy records are followed
        // by a second NUL-delimited path containing the original location.
        let path = String::from_utf8_lossy(&record[3..]).to_string();
        let original_path = if x == b'R' || y == b'R' || x == b'C' || y == b'C' {
            parts
                .next()
                .map(|original| String::from_utf8_lossy(original).to_string())
        } else {
            None
        };
        out.push(GitFileStatusEntry {
            path,
            status,
            original_path,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn git_fetch_all_returns_false_for_missing_directory() {
        let missing = tempfile::tempdir().unwrap().path().join("missing");
        let state = GitFetchState::default();
        assert!(
            !git_fetch_all_inner(missing.to_string_lossy().to_string(), &state)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn git_fetch_all_returns_false_for_non_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let state = GitFetchState::default();
        assert!(
            !git_fetch_all_inner(tmp.path().to_string_lossy().to_string(), &state)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn git_fetch_all_runs_for_repo_without_remotes() {
        if env::resolve_program("git").is_none() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let init = env::command("git")
            .arg("init")
            .arg(tmp.path())
            .output()
            .unwrap();
        assert!(init.status.success());

        let state = GitFetchState::default();
        assert!(
            git_fetch_all_inner(tmp.path().to_string_lossy().to_string(), &state)
                .await
                .unwrap()
        );
    }

    #[test]
    fn fetch_attempt_reservation_dedupes_recent_repo_keys() {
        let key = tempfile::tempdir().unwrap().path().join("repo.git");
        let state = GitFetchState::default();
        assert!(state.reserve_attempt(key.clone()));
        assert!(!state.reserve_attempt(key));
    }

    #[test]
    fn parses_git_file_status_porcelain_entries() {
        let text = b" M src/app.ts\0?? src/new file.ts\0A  src/added.ts\0 D src/missing.ts\0";
        let out = parse_git_file_status_porcelain_z(text);
        assert_eq!(out.len(), 4);
        assert_eq!(out[0].path, "src/app.ts");
        assert_eq!(out[0].status, "modified");
        assert_eq!(out[1].path, "src/new file.ts");
        assert_eq!(out[1].status, "untracked");
        assert_eq!(out[2].status, "added");
        assert_eq!(out[3].status, "deleted");
    }

    #[test]
    fn parses_git_file_status_rename_porcelain_entry() {
        let text = b"R  src/new.ts\0src/old.ts\0";
        let out = parse_git_file_status_porcelain_z(text);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "src/new.ts");
        assert_eq!(out[0].status, "renamed");
        assert_eq!(out[0].original_path.as_deref(), Some("src/old.ts"));
    }

    #[test]
    fn parses_nul_delimited_ignored_paths() {
        // `ls-files -z --directory` keeps a trailing slash on collapsed dirs
        // and leaves file paths (incl. spaces) intact.
        let text = b"node_modules/\0.env\0build/cache file.txt\0";
        let out = parse_nul_paths(text);
        assert_eq!(out, vec!["node_modules/", ".env", "build/cache file.txt"]);
        assert!(parse_nul_paths(b"").is_empty());
    }

    #[test]
    fn git_file_status_paths_are_relative_to_active_root() {
        let repo = PathBuf::from("/repo");
        let active = PathBuf::from("/repo/packages/app");
        assert_eq!(
            path_relative_to_active_root(&repo, &active, "packages/app/src/main.ts").as_deref(),
            Some("src/main.ts")
        );
        assert!(path_relative_to_active_root(&repo, &active, "other/file.ts").is_none());
    }
}
