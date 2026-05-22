//! Sidebar git status + native folder picker.
//!
//! `git_status` shells out to `git` rather than reimplementing
//! HEAD ref / porcelain parsing — the corner cases (worktrees,
//! detached HEAD, packed refs, submodules) are too cheap to skip and
//! too hairy to recreate. `pick_project_directory` wraps the dialog
//! plugin so the JS side doesn't pull in a direct dialog dependency.

use std::path::PathBuf;

use tauri::AppHandle;

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

#[tauri::command]
pub async fn git_status(path: String) -> Result<Option<GitStatus>, String> {
    use std::process::Command;
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Ok(None);
    }
    // Quick presence check — `git rev-parse --is-inside-work-tree`.
    // Saves spawning the porcelain pass on a non-git directory.
    let inside = Command::new("git")
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
    let branch_out = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["symbolic-ref", "--short", "HEAD"])
        .output()
        .ok();
    let branch = match branch_out {
        Some(o) if o.status.success() => {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        }
        _ => Command::new("git")
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
    let porcelain = Command::new("git")
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

/// One worktree row as reported by `git worktree list --porcelain`.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: String,
    /// Short branch name (no `refs/heads/` prefix). `None` for detached HEAD.
    pub branch: Option<String>,
    /// Commit SHA at the worktree's HEAD (short, 7 chars).
    pub head: Option<String>,
    /// True for the repository's main worktree (matches the `main` flag in
    /// porcelain output). The main worktree can't be `worktree remove`d.
    pub is_main: bool,
    /// True when `worktree list --porcelain` reports `locked`. Locked
    /// worktrees must be unlocked before removal.
    pub locked: bool,
}

/// One branch row for the "create worktree" picker.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
pub struct BranchInfo {
    pub name: String,
    /// True when the branch is currently checked out (in any worktree).
    pub current: bool,
}

/// List worktrees on a project. Shells out to
/// `git worktree list --porcelain` and parses the standard 4-line
/// record format. Returns an empty vec when the path isn't a git repo.
#[tauri::command]
pub async fn git_worktrees(project_path: String) -> Result<Vec<Worktree>, String> {
    use std::process::Command;
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("git worktree list: {e}"))?;
    if !output.status.success() {
        // Non-zero usually means "not a git repo"; treat as empty.
        return Ok(Vec::new());
    }
    Ok(parse_worktrees_porcelain(
        &String::from_utf8_lossy(&output.stdout),
    ))
}

fn parse_worktrees_porcelain(text: &str) -> Vec<Worktree> {
    // Porcelain shape (each record terminated by a blank line):
    //   worktree <path>
    //   HEAD <sha>
    //   branch refs/heads/<name>        (omitted when detached)
    //   bare | detached | locked …      (zero or more flags)
    let mut out: Vec<Worktree> = Vec::new();
    let mut cur: Option<Worktree> = None;
    let mut first = true;
    for line in text.lines() {
        if line.is_empty() {
            if let Some(mut w) = cur.take() {
                if first {
                    w.is_main = true;
                    first = false;
                }
                out.push(w);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            if let Some(mut w) = cur.take() {
                if first {
                    w.is_main = true;
                    first = false;
                }
                out.push(w);
            }
            cur = Some(Worktree {
                path: rest.to_string(),
                branch: None,
                head: None,
                is_main: false,
                locked: false,
            });
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            if let Some(w) = cur.as_mut() {
                w.head = Some(rest.chars().take(7).collect());
            }
        } else if let Some(rest) = line.strip_prefix("branch ") {
            if let Some(w) = cur.as_mut() {
                w.branch = Some(rest.trim_start_matches("refs/heads/").to_string());
            }
        } else if (line == "locked" || line.starts_with("locked "))
            && let Some(w) = cur.as_mut()
        {
            w.locked = true;
        }
    }
    if let Some(mut w) = cur.take() {
        if first {
            w.is_main = true;
        }
        out.push(w);
    }
    out
}

/// Create a new git worktree.
///
/// When `branch` already exists, the command checks it out into
/// `target_path`. Otherwise a new branch is created from `base`
/// (or HEAD when `base` is None). Returns the resulting Worktree
/// record so the frontend can immediately reflect it.
#[tauri::command]
pub async fn git_worktree_add(
    project_path: String,
    target_path: String,
    branch: String,
    base: Option<String>,
) -> Result<Worktree, String> {
    use std::process::Command;
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }
    // Detect whether the branch exists so we know whether to pass `-b`.
    let exists = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&dir).args(["worktree", "add"]);
    if !exists {
        cmd.arg("-b").arg(&branch).arg(&target_path);
        if let Some(b) = base.as_ref() {
            cmd.arg(b);
        }
    } else {
        cmd.arg(&target_path).arg(&branch);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("git worktree add: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    // Re-list so we hand back an accurate record (canonical path may
    // differ from what was passed in, HEAD will be set, etc.).
    let list = git_worktrees(project_path.clone()).await?;
    let canonical = std::fs::canonicalize(&target_path)
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    list.into_iter()
        .find(|w| {
            w.path == target_path
                || canonical.as_deref().is_some_and(|c| c == w.path)
        })
        .ok_or_else(|| "worktree created but missing from git worktree list".to_string())
}

/// Remove a git worktree. Refuses to remove the main worktree.
#[tauri::command]
pub async fn git_worktree_remove(
    project_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    use std::process::Command;
    let dir = PathBuf::from(&project_path);
    let list = git_worktrees(project_path.clone()).await?;
    let canonical = std::fs::canonicalize(&worktree_path)
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    let target = list
        .iter()
        .find(|w| {
            w.path == worktree_path
                || canonical.as_deref().is_some_and(|c| c == w.path)
        })
        .ok_or_else(|| format!("worktree not tracked: {worktree_path}"))?;
    if target.is_main {
        return Err("cannot remove the main worktree".to_string());
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&dir).args(["worktree", "remove"]);
    if force {
        cmd.arg("--force");
    }
    cmd.arg(&worktree_path);
    let output = cmd
        .output()
        .map_err(|e| format!("git worktree remove: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// List local branches with a `current` flag for the active branch.
/// Used by the "create worktree from existing branch" picker.
#[tauri::command]
pub async fn git_branch_list(project_path: String) -> Result<Vec<BranchInfo>, String> {
    use std::process::Command;
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["for-each-ref", "--format=%(HEAD) %(refname:short)", "refs/heads/"])
        .output()
        .map_err(|e| format!("git for-each-ref: {e}"))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let mut branches = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (mark, rest) = line.split_at(1);
        let name = rest.trim().to_string();
        if name.is_empty() {
            continue;
        }
        branches.push(BranchInfo {
            name,
            current: mark == "*",
        });
    }
    Ok(branches)
}

/// Pop a native folder picker and return the chosen path (or None if the
/// user cancelled). Wrapping `tauri-plugin-dialog::pick_folder` here keeps
/// the frontend free of a direct dialog dependency — the projects feature
/// is the only place we open native dialogs, so a single command is
/// simpler than wiring the plugin's permissions through the JS side too.
#[tauri::command]
pub async fn pick_project_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .set_title("Choose project directory")
        .pick_folder(move |path| {
            // FilePath → PathBuf; oneshot send is fire-and-forget — if the
            // receiver dropped (window closed mid-pick) the result is
            // simply discarded.
            let resolved: Option<PathBuf> = match path {
                Some(fp) => fp.into_path().ok(),
                None => None,
            };
            let _ = tx.send(resolved);
        });
    let path = rx.await.map_err(|e| format!("dialog channel: {e}"))?;
    Ok(path.map(|p| p.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn init_repo(path: &std::path::Path) {
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args([
                "-c", "init.defaultBranch=main",
                "init", "-q",
            ])
            .status()
            .expect("git init");
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args([
                "-c", "user.name=test",
                "-c", "user.email=test@example.com",
                "commit", "--allow-empty", "-q", "-m", "init",
            ])
            .status()
            .expect("git commit");
    }

    #[test]
    fn parses_single_worktree_porcelain() {
        let text = "worktree /tmp/repo\nHEAD 1234567abcdef\nbranch refs/heads/main\n\n";
        let out = parse_worktrees_porcelain(text);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "/tmp/repo");
        assert_eq!(out[0].branch.as_deref(), Some("main"));
        assert_eq!(out[0].head.as_deref(), Some("1234567"));
        assert!(out[0].is_main);
    }

    #[test]
    fn parses_multiple_worktrees_with_main_flag() {
        let text = "worktree /tmp/repo\nHEAD aaaaaaa\nbranch refs/heads/main\n\nworktree /tmp/repo-feat\nHEAD bbbbbbb\nbranch refs/heads/feature\n\n";
        let out = parse_worktrees_porcelain(text);
        assert_eq!(out.len(), 2);
        assert!(out[0].is_main);
        assert!(!out[1].is_main);
        assert_eq!(out[1].branch.as_deref(), Some("feature"));
    }

    #[test]
    fn parses_detached_head_worktree() {
        let text = "worktree /tmp/repo\nHEAD ccccccc\ndetached\n\n";
        let out = parse_worktrees_porcelain(text);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].branch, None);
        assert_eq!(out[0].head.as_deref(), Some("ccccccc"));
    }

    #[test]
    fn parses_locked_worktree() {
        let text = "worktree /tmp/repo\nHEAD ddddddd\nbranch refs/heads/main\nlocked some reason\n\n";
        let out = parse_worktrees_porcelain(text);
        assert!(out[0].locked);
    }

    #[tokio::test]
    async fn list_returns_empty_for_non_git_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().to_string();
        let list = git_worktrees(path).await.expect("worktrees");
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn list_returns_main_worktree_for_fresh_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let path = dir.path().to_string_lossy().to_string();
        let list = git_worktrees(path).await.expect("worktrees");
        assert_eq!(list.len(), 1);
        assert!(list[0].is_main);
    }

    #[tokio::test]
    async fn add_and_remove_worktree_round_trip() {
        // Git's worktree code path requires `git` on PATH; this test
        // skips silently if git can't init (CI without git installed).
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let project_path = dir.path().to_string_lossy().to_string();
        let target = parent.path().join("feature-x");
        let target_str = target.to_string_lossy().to_string();
        let wt = git_worktree_add(
            project_path.clone(),
            target_str.clone(),
            "feature-x".to_string(),
            None,
        )
        .await
        .expect("worktree add");
        assert_eq!(wt.branch.as_deref(), Some("feature-x"));
        let listed = git_worktrees(project_path.clone())
            .await
            .expect("list");
        assert_eq!(listed.len(), 2);
        git_worktree_remove(project_path.clone(), target_str, false)
            .await
            .expect("worktree remove");
        let after = git_worktrees(project_path).await.expect("list after");
        assert_eq!(after.len(), 1);
    }

    #[tokio::test]
    async fn remove_main_worktree_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let project_path = dir.path().to_string_lossy().to_string();
        let err = git_worktree_remove(project_path.clone(), project_path, false)
            .await
            .expect_err("must reject");
        assert!(err.contains("main"));
    }

    #[tokio::test]
    async fn branch_list_includes_current() {
        let dir = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let project_path = dir.path().to_string_lossy().to_string();
        let list = git_branch_list(project_path).await.expect("branch list");
        assert_eq!(list.len(), 1);
        assert!(list[0].current);
        assert_eq!(list[0].name, "main");
    }
}
