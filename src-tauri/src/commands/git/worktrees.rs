use std::path::{Component, Path, PathBuf};

use crate::env;

/// One worktree row as reported by `git worktree list --porcelain`.
/// `serde(rename_all = "camelCase")` matches the TS `GitWorktreeRecord`
/// shape — without it, `is_main` would serialize as `is_main` and the
/// frontend's `rec.isMain` reads `undefined`, silently treating every
/// worktree as non-main (which broke "Create worktree" reconciliation).
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
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
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let output = env::command("git")
        .arg("-C")
        .arg(&dir)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("git worktree list: {e}"))?;
    if !output.status.success() {
        // Non-zero usually means "not a git repo"; treat as empty.
        return Ok(Vec::new());
    }
    Ok(parse_worktrees_porcelain(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

pub(crate) fn parse_worktrees_porcelain(text: &str) -> Vec<Worktree> {
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
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }
    // Detect whether the branch exists so we know whether to pass `-b`.
    let exists = env::command("git")
        .arg("-C")
        .arg(&dir)
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let mut cmd = env::command("git");
    cmd.arg("-C").arg(&dir).args(["worktree", "add"]);
    if !exists {
        cmd.arg("-b").arg(&branch).arg(&target_path);
        if let Some(b) = base.as_ref() {
            cmd.arg(b);
        }
    } else {
        cmd.arg(&target_path).arg(&branch);
    }
    let output = cmd.output().map_err(|e| format!("git worktree add: {e}"))?;
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
        .find(|w| w.path == target_path || canonical.as_deref().is_some_and(|c| c == w.path))
        .ok_or_else(|| "worktree created but missing from git worktree list".to_string())
}

/// Remove a git worktree. Refuses to remove the main worktree.
#[tauri::command]
pub async fn git_worktree_remove(
    project_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }
    let list = git_worktrees(project_path.clone()).await?;
    let canonical = std::fs::canonicalize(&worktree_path)
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    let target = list
        .iter()
        .find(|w| w.path == worktree_path || canonical.as_deref().is_some_and(|c| c == w.path))
        .ok_or_else(|| format!("worktree not tracked: {worktree_path}"))?;
    if target.is_main {
        return Err("cannot remove the main worktree".to_string());
    }
    let mut cmd = env::command("git");
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

/// Remove a worktree that git no longer tracks (registry pruned, dir
/// left behind). The strict `git_worktree_remove` refuses these paths —
/// this is the recovery escape hatch. Verifies the target genuinely
/// looks like an orphan of the given project before touching disk:
/// not in `git worktree list`, `.git` marker points into
/// `<project>/.git/worktrees/`, and the target is not the project root.
/// Sends the directory to the OS trash (never `unlink`) and runs
/// `git worktree prune` to clear any stale registry residue.
#[tauri::command]
pub async fn git_worktree_remove_orphan(
    project_path: String,
    worktree_path: String,
) -> Result<(), String> {
    let project = PathBuf::from(&project_path);
    let target = PathBuf::from(&worktree_path);
    if project == target {
        return Err("cannot remove the main worktree".to_string());
    }
    // Refuse if git already knows about this path — caller should use
    // `git_worktree_remove` (with `force=true` if dirty).
    let list = git_worktrees(project_path.clone()).await?;
    let canonical = std::fs::canonicalize(&worktree_path)
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    let still_tracked = list
        .iter()
        .any(|w| w.path == worktree_path || canonical.as_deref().is_some_and(|c| c == w.path));
    if still_tracked {
        return Err(
            "worktree is still tracked by git; use git_worktree_remove instead".to_string(),
        );
    }
    // Authorize the path: the `.git` marker must point into this
    // project's `.git/worktrees/` directory. Anything else (a plain
    // folder the user typed in by accident, an unrelated worktree
    // from another repo) is refused.
    let marker = target.join(".git");
    if !marker.is_file() {
        return Err(format!(
            "not an orphan worktree: {worktree_path} has no .git marker file"
        ));
    }
    let contents =
        std::fs::read_to_string(&marker).map_err(|e| format!("read .git marker: {e}"))?;
    let gitdir = contents
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("gitdir:").map(str::trim))
        .ok_or_else(|| format!("not an orphan worktree: {worktree_path} has malformed .git"))?;
    // Canonicalize project so a symlinked tmpdir (macOS `/var` →
    // `/private/var`) doesn't cause a false-negative. Normalize the
    // marker target lexically before the prefix check so a crafted
    // `.../.git/worktrees/../outside` marker cannot pass by string shape.
    let project_canon =
        std::fs::canonicalize(&project).map_err(|e| format!("resolve project path: {e}"))?;
    let expected_prefix = project_canon.join(".git").join("worktrees");
    let gitdir_path = normalize_gitdir_path(&marker, gitdir)
        .ok_or_else(|| format!("not an orphan worktree: {worktree_path} has invalid .git path"))?;
    if !gitdir_path.starts_with(&expected_prefix) {
        return Err(format!(
            "not tracked by this project: {worktree_path} .git points outside {}",
            expected_prefix.display()
        ));
    }
    // `git worktree prune` clears any stale registry residue (the
    // gitdir target may or may not still exist).
    let _ = env::command("git")
        .arg("-C")
        .arg(&project)
        .args(["worktree", "prune"])
        .output();
    // Send the dir to the OS trash. Mirrors `commands::fs::fs_delete`
    // — never `unlink`, never permanent.
    if target.exists() {
        trash::delete(&target).map_err(|e| format!("trash {worktree_path}: {e}"))?;
    }
    Ok(())
}

fn normalize_gitdir_path(marker: &Path, gitdir: &str) -> Option<PathBuf> {
    let raw = Path::new(gitdir);
    let path = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        marker.parent()?.join(raw)
    };
    normalize_path(&path)
}

fn normalize_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
        }
    }
    Some(normalized)
}

/// List local branches with a `current` flag for the active branch.
/// Used by the "create worktree from existing branch" picker.
#[tauri::command]
pub async fn git_branch_list(project_path: String) -> Result<Vec<BranchInfo>, String> {
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let output = env::command("git")
        .arg("-C")
        .arg(&dir)
        .args([
            "for-each-ref",
            "--format=%(HEAD) %(refname:short)",
            "refs/heads/",
        ])
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::git::test_support::init_repo;

    #[test]
    fn worktree_serializes_with_camel_case_keys() {
        // The TS GitWorktreeRecord shape expects `isMain` / `branch` /
        // `head` / `path` / `locked`. Without the `rename_all`
        // attribute the bool ships as `is_main` and rec.isMain on the
        // frontend reads `undefined` — which silently breaks the
        // "Create worktree" reconcile loop.
        let w = Worktree {
            path: "/x".into(),
            branch: Some("main".into()),
            head: Some("abcdef0".into()),
            is_main: true,
            locked: false,
        };
        let json = serde_json::to_value(&w).unwrap();
        assert!(json.get("isMain").is_some());
        assert!(json.get("is_main").is_none());
        assert_eq!(json["isMain"], serde_json::json!(true));
        assert_eq!(json["path"], serde_json::json!("/x"));
        assert_eq!(json["branch"], serde_json::json!("main"));
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
        let text =
            "worktree /tmp/repo\nHEAD ddddddd\nbranch refs/heads/main\nlocked some reason\n\n";
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
        let listed = git_worktrees(project_path.clone()).await.expect("list");
        assert_eq!(listed.len(), 2);
        git_worktree_remove(project_path.clone(), target_str, false)
            .await
            .expect("worktree remove");
        let after = git_worktrees(project_path).await.expect("list after");
        assert_eq!(after.len(), 1);
    }

    #[tokio::test]
    async fn remove_worktree_rejects_invalid_project_path() {
        let missing = tempfile::tempdir().expect("tempdir").path().join("missing");
        let err = git_worktree_remove(
            missing.to_string_lossy().to_string(),
            "/tmp/not-a-worktree".to_string(),
            false,
        )
        .await
        .expect_err("invalid project path must be rejected");
        assert!(err.contains("not a directory"), "got: {err}");
    }

    #[tokio::test]
    async fn remove_orphan_drops_pruned_worktree() {
        // Simulate the dangling state: a worktree was created, then
        // its `.git/worktrees/<name>/` entry was pruned externally,
        // but the on-disk dir survives.
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let project_path = dir.path().to_string_lossy().to_string();
        let target = parent.path().join("orphan");
        let target_str = target.to_string_lossy().to_string();
        git_worktree_add(
            project_path.clone(),
            target_str.clone(),
            "orphan".to_string(),
            None,
        )
        .await
        .expect("worktree add");
        // Manually prune the registry entry. Leaves the on-disk dir
        // intact with a now-dangling `.git` marker file.
        std::fs::remove_dir_all(dir.path().join(".git/worktrees/orphan"))
            .expect("remove registry entry");
        // Sanity: strict remove must refuse.
        let err = git_worktree_remove(project_path.clone(), target_str.clone(), false)
            .await
            .expect_err("strict remove must refuse a pruned worktree");
        assert!(
            err.contains("not tracked"),
            "expected 'not tracked' in strict remove err, got: {err}"
        );
        // The orphan path cleans it up.
        git_worktree_remove_orphan(project_path.clone(), target_str.clone())
            .await
            .expect("orphan remove");
        // On-disk dir is gone (sent to trash by `trash::delete`; the
        // assertion is that the path is no longer reachable).
        assert!(
            !target.exists(),
            "orphan dir should be gone after remove_orphan"
        );
    }

    #[tokio::test]
    async fn remove_orphan_refuses_parent_dir_gitdir_escape() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let project_path = dir.path().to_string_lossy().to_string();
        std::fs::write(
            target.path().join(".git"),
            format!(
                "gitdir: {}/../../outside\n",
                dir.path().join(".git/worktrees/orphan").display()
            ),
        )
        .expect("write fake .git");
        let err =
            git_worktree_remove_orphan(project_path, target.path().to_string_lossy().to_string())
                .await
                .expect_err("must reject marker escaping worktrees prefix");
        assert!(err.contains("not tracked by this project"), "got: {err}");
        assert!(target.path().exists());
    }

    #[tokio::test]
    async fn remove_orphan_refuses_live_worktree() {
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let project_path = dir.path().to_string_lossy().to_string();
        let target = parent.path().join("alive");
        let target_str = target.to_string_lossy().to_string();
        git_worktree_add(
            project_path.clone(),
            target_str.clone(),
            "alive".to_string(),
            None,
        )
        .await
        .expect("worktree add");
        let err = git_worktree_remove_orphan(project_path, target_str)
            .await
            .expect_err("must refuse a live worktree");
        assert!(
            err.contains("still tracked") || err.contains("not orphaned"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn remove_orphan_refuses_main_worktree() {
        let dir = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let project_path = dir.path().to_string_lossy().to_string();
        let err = git_worktree_remove_orphan(project_path.clone(), project_path)
            .await
            .expect_err("must refuse main worktree");
        assert!(
            err.contains("main") || err.contains("still tracked"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn remove_orphan_refuses_unrelated_path() {
        // Defense in depth: even with a dangling `.git`-marker shape,
        // a path outside the project tree (no `gitdir:` pointing into
        // `<project>/.git/worktrees/`) must be refused. Stops a buggy
        // caller from trashing arbitrary directories.
        let dir = tempfile::tempdir().expect("tempdir");
        let unrelated = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let project_path = dir.path().to_string_lossy().to_string();
        std::fs::write(
            unrelated.path().join(".git"),
            "gitdir: /var/empty/no-such-thing\n",
        )
        .expect("write fake .git");
        let err = git_worktree_remove_orphan(
            project_path,
            unrelated.path().to_string_lossy().to_string(),
        )
        .await
        .expect_err("must refuse unrelated path");
        assert!(
            err.contains("not an orphan") || err.contains("not tracked by this project"),
            "got: {err}"
        );
        // And the dir must still exist — we didn't touch it.
        assert!(unrelated.path().exists());
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
