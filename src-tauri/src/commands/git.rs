//! Sidebar git status + native folder picker.
//!
//! `git_status` shells out to `git` rather than reimplementing
//! HEAD ref / porcelain parsing — the corner cases (worktrees,
//! detached HEAD, packed refs, submodules) are too cheap to skip and
//! too hairy to recreate. `pick_project_directory` wraps the dialog
//! plugin so the JS side doesn't pull in a direct dialog dependency.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::env;

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

    let top_level = env::command("git")
        .arg("-C")
        .arg(&dir)
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

fn path_relative_to_active_root(
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

fn parse_git_file_status_porcelain_z(bytes: &[u8]) -> Vec<GitFileStatusEntry> {
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
    let still_tracked = list.iter().any(|w| {
        w.path == worktree_path || canonical.as_deref().is_some_and(|c| c == w.path)
    });
    if still_tracked {
        return Err("worktree is still tracked by git; use git_worktree_remove instead".to_string());
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
    let contents = std::fs::read_to_string(&marker)
        .map_err(|e| format!("read .git marker: {e}"))?;
    let gitdir = contents
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("gitdir:").map(str::trim))
        .ok_or_else(|| format!("not an orphan worktree: {worktree_path} has malformed .git"))?;
    // Canonicalize project so a symlinked tmpdir (macOS `/var` →
    // `/private/var`) doesn't cause a false-negative. Git writes the
    // physical path into `.git`, so `gitdir` is already resolved.
    let project_canon = std::fs::canonicalize(&project)
        .map_err(|e| format!("resolve project path: {e}"))?;
    let expected_prefix = project_canon.join(".git").join("worktrees");
    if !PathBuf::from(gitdir).starts_with(&expected_prefix) {
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

/// GitHub branch status as understood by `gh` CLI. Returned shape is
/// intentionally narrow so the worktree-landing UI can render without
/// dragging the full Octocrab schema.
///
/// All fields are best-effort. `gh_available = false` means we couldn't
/// find / auth `gh`; the UI degrades gracefully (renders "Connect
/// GitHub" instead of an error). `pushed` is true when the branch
/// exists on the remote (we look it up via `gh api`). `prs` lists open
/// + recently-closed PRs whose head matches the branch.
#[derive(serde::Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GhBranchStatus {
    /// True when the `gh` CLI binary was reachable AND authenticated.
    /// When false, every other field is empty/None.
    pub gh_available: bool,
    /// `<owner>/<repo>` if the repo has a recognised GitHub remote.
    pub repo: Option<String>,
    /// True when `gh api repos/<repo>/branches/<branch>` returned 200.
    /// Implies the branch is pushed.
    pub pushed: bool,
    /// PRs whose head is the requested branch. Includes open + recently
    /// closed PRs so users see merge state when the branch is gone.
    pub prs: Vec<GhPr>,
    /// True when the worktree directory still exists on disk but its
    /// `.git` file points to a `.git/worktrees/<name>/` entry that's
    /// been pruned externally. Distinct from `gh_available=false`
    /// (gh missing) and `repo=None` (no GitHub remote) — those are
    /// healthy states, this one means the user should clean up the
    /// stale entry.
    pub worktree_broken: bool,
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhPr {
    pub number: u64,
    pub state: String,
    pub title: String,
    pub url: String,
    pub is_draft: bool,
    pub merged: bool,
    pub base_ref_name: String,
}

/// Fetch GitHub branch status via `gh` CLI. Silently degrades on every
/// failure mode — missing binary, not authed, non-GitHub remote, network
/// error — so the worktree landing always renders. The frontend reads
/// `ghAvailable` first; on false everything else is ignored.
#[tauri::command]
pub async fn gh_branch_status(
    project_path: String,
    branch: String,
) -> Result<GhBranchStatus, String> {
    Ok(gh_branch_status_inner(&project_path, &branch))
}

/// Detect a worktree whose on-disk `.git` file points to a pruned
/// `.git/worktrees/<name>/` entry. Hermetic — no git process spawn,
/// no network. Returns false for a plain (non-worktree) directory or
/// a healthy repo.
fn worktree_is_dangling(dir: &std::path::Path) -> bool {
    let marker = dir.join(".git");
    if !marker.is_file() {
        return false;
    }
    let Ok(contents) = std::fs::read_to_string(&marker) else {
        return false;
    };
    let Some(target) = contents
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("gitdir:").map(str::trim))
    else {
        return false;
    };
    !std::path::Path::new(target).exists()
}

fn gh_branch_status_inner(project_path: &str, branch: &str) -> GhBranchStatus {
    let mut status = GhBranchStatus::default();
    let dir = PathBuf::from(project_path);
    if !dir.is_dir() || branch.is_empty() {
        return status;
    }
    // 0. Short-circuit on a dangling worktree (registry pruned, dir
    //    still on disk). Every git invocation below would fail; we'd
    //    end up with `gh_available=true, repo=None` and the landing
    //    would mislabel it as "no GitHub remote".
    if worktree_is_dangling(&dir) {
        status.worktree_broken = true;
        return status;
    }
    // 1. gh available + authed?
    let auth = env::command("gh").args(["auth", "status"]).output();
    let Ok(out) = auth else { return status };
    if !out.status.success() {
        return status;
    }
    status.gh_available = true;

    // 2. Identify the GitHub <owner>/<repo>. `gh repo view` takes a
    //    positional `[<repository>]` arg (not a `-R` flag — `repo view`
    //    is the one subcommand that doesn't share the `--repo` family
    //    convention), so we rely on `current_dir(&dir)` and a bare
    //    invocation. Output empty / non-zero on non-GitHub remotes,
    //    which doubles as our "is this on GitHub?" check.
    let repo_out = env::command("gh")
        .args([
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ])
        .current_dir(&dir)
        .output();
    let repo_str = match repo_out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => return status,
    };
    if repo_str.is_empty() {
        return status;
    }
    status.repo = Some(repo_str.clone());

    // 3. Branch exists on remote? `gh api` returns 200 with the branch
    //    metadata when present; non-200 means not pushed. Branch names
    //    containing slashes (`feat/foo`, `release/1.2.3`) must be
    //    percent-encoded — otherwise GitHub treats the trailing segment
    //    as a separate path element and returns 404 even when the
    //    branch exists.
    let branch_encoded = url_encode_path_segment(branch);
    let pushed_out = env::command("gh")
        .args([
            "api",
            "-X",
            "GET",
            &format!("repos/{repo_str}/branches/{branch_encoded}"),
            "--silent",
        ])
        .current_dir(&dir)
        .output();
    if let Ok(o) = pushed_out {
        status.pushed = o.status.success();
    }

    // 4. PRs whose head is this branch. `gh pr list --state all` covers
    //    open + closed (incl. merged). Limit 5 keeps the call cheap and
    //    the UI tidy. `--json` makes parsing robust against future CLI
    //    output tweaks.
    let pr_out = env::command("gh")
        .args([
            "pr",
            "list",
            "--repo",
            &repo_str,
            "--state",
            "all",
            "--head",
            branch,
            "--limit",
            "5",
            "--json",
            "number,state,title,url,isDraft,baseRefName,mergedAt",
        ])
        .current_dir(&dir)
        .output();
    if let Ok(o) = pr_out
        && o.status.success()
        && let Ok(parsed) = serde_json::from_slice::<Vec<serde_json::Value>>(&o.stdout)
    {
        for entry in parsed {
            let number = entry.get("number").and_then(|v| v.as_u64());
            let state = entry
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = entry
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let url = entry
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let is_draft = entry
                .get("isDraft")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let base_ref_name = entry
                .get("baseRefName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let merged = entry.get("mergedAt").map(|v| !v.is_null()).unwrap_or(false);
            if let Some(n) = number {
                status.prs.push(GhPr {
                    number: n,
                    state,
                    title,
                    url,
                    is_draft,
                    merged,
                    base_ref_name,
                });
            }
        }
    }
    status
}

/// Repo-level GitHub data for the per-project dashboard.
///
/// `gh_available = false` collapses every other field. Counts default to
/// 0 on parse failure rather than panicking — the dashboard renders a
/// dash for unknown values, never an error.
#[derive(serde::Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GhRepoOverview {
    pub gh_available: bool,
    pub repo: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub default_branch: Option<String>,
    pub stargazer_count: i64,
    pub fork_count: i64,
    pub open_issues_count: i64,
    pub open_prs_count: i64,
    /// ISO 8601 string of the last push to any branch.
    pub pushed_at: Option<String>,
}

/// Parsed subset of `gh repo view --json …` output. Split into its own
/// struct so a sync unit test can exercise the parser without shelling
/// out to gh.
#[derive(Debug, PartialEq)]
pub(crate) struct RepoViewParts {
    pub repo: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub default_branch: Option<String>,
    pub stargazer_count: i64,
    pub fork_count: i64,
    pub pushed_at: Option<String>,
}

/// Percent-encode a single URL path segment. We avoid pulling
/// `url`/`percent-encoding` for this one-call site; the rules are
/// "encode everything outside the RFC 3986 unreserved set". Suitable
/// for branch names being placed into `repos/{owner}/{repo}/branches/{x}`.
pub(crate) fn url_encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let unreserved =
            b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~';
        if unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(crate) fn parse_repo_view_json(s: &str) -> Option<RepoViewParts> {
    fn strip_empty(x: &serde_json::Value) -> Option<String> {
        x.as_str().filter(|s| !s.is_empty()).map(String::from)
    }
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    Some(RepoViewParts {
        repo: v.get("nameWithOwner").and_then(strip_empty),
        description: v.get("description").and_then(strip_empty),
        url: v.get("url").and_then(strip_empty),
        default_branch: v
            .get("defaultBranchRef")
            .and_then(|x| x.get("name"))
            .and_then(strip_empty),
        stargazer_count: v
            .get("stargazerCount")
            .and_then(|x| x.as_i64())
            .unwrap_or(0),
        fork_count: v.get("forkCount").and_then(|x| x.as_i64()).unwrap_or(0),
        pushed_at: v.get("pushedAt").and_then(strip_empty),
    })
}

/// Fetch repo-level GitHub data for the per-project dashboard. Three
/// parallel `gh` calls inside `tokio::join!` so the total latency is
/// max-of-three, not sum. Each is wrapped in a 4s timeout — partial
/// data is fine, the UI shows dashes for fields that didn't come back.
///
/// Degrades silently on missing/un-authed gh, non-GitHub remotes, and
/// timeouts. The `ghAvailable` flag is the UI's gate.
#[tauri::command]
pub async fn gh_repo_overview(project_path: String) -> Result<GhRepoOverview, String> {
    Ok(gh_repo_overview_inner(&project_path).await)
}

async fn gh_repo_overview_inner(project_path: &str) -> GhRepoOverview {
    use std::time::Duration;
    let mut overview = GhRepoOverview::default();
    let dir = PathBuf::from(project_path);
    if !dir.is_dir() {
        return overview;
    }

    // gh available + authed?
    let auth = env::tokio_command("gh")
        .args(["auth", "status"])
        .output()
        .await;
    let Ok(out) = auth else { return overview };
    if !out.status.success() {
        return overview;
    }
    overview.gh_available = true;

    let dir_a = dir.clone();
    let repo_view_fut = async move {
        env::tokio_command("gh")
            .args([
                "repo",
                "view",
                "--json",
                "nameWithOwner,description,url,defaultBranchRef,stargazerCount,forkCount,pushedAt",
            ])
            .current_dir(&dir_a)
            .output()
            .await
    };

    let dir_b = dir.clone();
    let pr_count_fut = async move {
        env::tokio_command("gh")
            .args([
                "pr", "list", "--state", "open", "--json", "number", "-q", "length",
            ])
            .current_dir(&dir_b)
            .output()
            .await
    };

    // Issue count needs the <owner>/<repo>. Re-resolve inside this future
    // so the three top-level calls still run in parallel — the sequential
    // sub-pair here is still bounded by the same 4s timeout.
    let dir_c = dir.clone();
    // `gh issue list -q length` returns ONLY issues (gh filters out PRs
    // on its side), unlike `repos/<owner>/<repo>.open_issues_count`
    // which counts issues + PRs together and inflates the dashboard
    // figure when the repo has open PRs.
    let issue_count_fut = async move {
        let count_out = env::tokio_command("gh")
            .args([
                "issue", "list", "--state", "open", "--limit", "1000", "--json", "number", "-q",
                "length",
            ])
            .current_dir(&dir_c)
            .output()
            .await
            .ok()?;
        if !count_out.status.success() {
            return None::<i64>;
        }
        String::from_utf8_lossy(&count_out.stdout)
            .trim()
            .parse::<i64>()
            .ok()
    };

    let (repo_view, pr_count, issue_count) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(4), repo_view_fut),
        tokio::time::timeout(Duration::from_secs(4), pr_count_fut),
        tokio::time::timeout(Duration::from_secs(4), issue_count_fut),
    );

    if let Ok(Ok(o)) = repo_view
        && o.status.success()
        && let Some(parts) = parse_repo_view_json(&String::from_utf8_lossy(&o.stdout))
    {
        overview.repo = parts.repo;
        overview.description = parts.description;
        overview.url = parts.url;
        overview.default_branch = parts.default_branch;
        overview.stargazer_count = parts.stargazer_count;
        overview.fork_count = parts.fork_count;
        overview.pushed_at = parts.pushed_at;
    }
    if let Ok(Ok(o)) = pr_count
        && o.status.success()
    {
        overview.open_prs_count = String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse::<i64>()
            .unwrap_or(0);
    }
    if let Ok(Some(n)) = issue_count {
        overview.open_issues_count = n;
    }

    overview
}

/// Compact view of a single GitHub issue, surfaced on the dashboard.
/// camelCase serde so the TS side reads it as-is.
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhIssue {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub labels: Vec<GhIssueLabel>,
    /// ISO 8601 — surface "updated 3d ago" on the card.
    pub updated_at: Option<String>,
    pub author: Option<String>,
    pub comments: i64,
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhIssueLabel {
    pub name: String,
    /// Hex color (without `#`) so the frontend can render the chip.
    pub color: Option<String>,
}

/// Detailed fetch for a single issue, used when the user picks "send
/// to agent" — we need the body, not just the headline.
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhIssueDetail {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub body: String,
    pub author: Option<String>,
}

pub(crate) fn parse_gh_issue_list(s: &str) -> Vec<GhIssue> {
    let v: serde_json::Value = match serde_json::from_str(s) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match v.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter()
        .filter_map(|item| {
            let number = item.get("number")?.as_i64()?;
            let title = item.get("title")?.as_str()?.to_string();
            let url = item.get("url")?.as_str()?.to_string();
            let state = item
                .get("state")
                .and_then(|x| x.as_str())
                .unwrap_or("OPEN")
                .to_string();
            let updated_at = item
                .get("updatedAt")
                .and_then(|x| x.as_str())
                .map(String::from);
            let author = item
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|s| s.as_str())
                .map(String::from);
            let comments = item.get("comments").and_then(|x| x.as_i64()).unwrap_or(0);
            let labels = item
                .get("labels")
                .and_then(|x| x.as_array())
                .map(|labels| {
                    labels
                        .iter()
                        .filter_map(|l| {
                            let name = l.get("name")?.as_str()?.to_string();
                            let color = l.get("color").and_then(|c| c.as_str()).map(String::from);
                            Some(GhIssueLabel { name, color })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(GhIssue {
                number,
                title,
                url,
                state,
                labels,
                updated_at,
                author,
                comments,
            })
        })
        .collect()
}

/// List open issues for the gh-resolved repository at `project_path`.
/// Empty Vec when gh isn't installed / not auth'd / repo not on GH —
/// the dashboard renders the empty state in that case rather than an
/// error. `limit` is clamped to [1, 100] to keep one shell-out fast.
#[tauri::command]
pub async fn gh_issue_list(project_path: String, limit: Option<u32>) -> Vec<GhIssue> {
    use std::time::Duration;
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Vec::new();
    }
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let limit_str = limit.to_string();
    tokio::time::timeout(Duration::from_secs(5), async {
        let out = env::tokio_command("gh")
            .args([
                "issue",
                "list",
                "--state",
                "open",
                "--limit",
                &limit_str,
                "--json",
                "number,title,url,state,labels,updatedAt,author,comments",
            ])
            .current_dir(&dir)
            .output()
            .await
            .ok()?;
        if !out.status.success() {
            return Some(Vec::new());
        }
        Some(parse_gh_issue_list(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
    .unwrap_or(Some(Vec::new()))
    .unwrap_or_default()
}

/// Fetch a single issue's body + author. Separate from `gh_issue_list`
/// so the list view stays cheap; this is only called when the user
/// picks "send to agent" so we have the full content to forward.
#[tauri::command]
pub async fn gh_issue_view(project_path: String, number: i64) -> Result<GhIssueDetail, String> {
    use std::time::Duration;
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }
    if number <= 0 {
        return Err("issue number must be positive".into());
    }
    let out = tokio::time::timeout(Duration::from_secs(5), async {
        env::tokio_command("gh")
            .args([
                "issue",
                "view",
                &number.to_string(),
                "--json",
                "number,title,url,body,author",
            ])
            .current_dir(&dir)
            .output()
            .await
    })
    .await
    .map_err(|_| "gh issue view timed out".to_string())?
    .map_err(|e| format!("gh issue view: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("gh issue view: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("gh issue view: bad json: {e}"))?;
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let url = v
        .get("url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let body = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let author = v
        .get("author")
        .and_then(|a| a.get("login"))
        .and_then(|s| s.as_str())
        .map(String::from);
    Ok(GhIssueDetail {
        number,
        title,
        url,
        body,
        author,
    })
}

/// Resolve a GitHub avatar URL for the repo at `project_path`. Returns
/// `https://github.com/{owner}.png?size=200` when the repo is on GitHub
/// (avatar URL is stable + cacheable + no API token required), else
/// `None`. Used by `src/projectIcons.ts` as the network fallback after
/// a local logo scan misses.
#[tauri::command]
pub async fn gh_repo_avatar_url(project_path: String) -> Option<String> {
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return None;
    }
    let out = env::tokio_command("gh")
        .args([
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ])
        .current_dir(&dir)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name_with_owner = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (owner, _) = name_with_owner.split_once('/')?;
    if owner.is_empty() {
        return None;
    }
    Some(format!("https://github.com/{owner}.png?size=200"))
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
            .args(["-c", "init.defaultBranch=main", "init", "-q"])
            .status()
            .expect("git init");
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args([
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-q",
                "-m",
                "init",
            ])
            .status()
            .expect("git commit");
    }

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
    fn git_file_status_paths_are_relative_to_active_root() {
        let repo = PathBuf::from("/repo");
        let active = PathBuf::from("/repo/packages/app");
        assert_eq!(
            path_relative_to_active_root(&repo, &active, "packages/app/src/main.ts").as_deref(),
            Some("src/main.ts")
        );
        assert!(path_relative_to_active_root(&repo, &active, "other/file.ts").is_none());
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

    #[test]
    fn parses_gh_repo_view_full_fixture() {
        // Trimmed real `gh repo view --json …` output. Confirms field
        // extraction lines up with the camelCase contract the TS side
        // expects.
        let fixture = r#"{
            "nameWithOwner": "anthropics/claude-code",
            "description": "Claude Code is the official CLI for Claude.",
            "url": "https://github.com/anthropics/claude-code",
            "defaultBranchRef": { "name": "main" },
            "stargazerCount": 4321,
            "forkCount": 87,
            "pushedAt": "2026-05-21T19:04:11Z"
        }"#;
        let parts = parse_repo_view_json(fixture).expect("parse");
        assert_eq!(parts.repo.as_deref(), Some("anthropics/claude-code"));
        assert_eq!(
            parts.description.as_deref(),
            Some("Claude Code is the official CLI for Claude.")
        );
        assert_eq!(parts.default_branch.as_deref(), Some("main"));
        assert_eq!(parts.stargazer_count, 4321);
        assert_eq!(parts.fork_count, 87);
        assert_eq!(parts.pushed_at.as_deref(), Some("2026-05-21T19:04:11Z"));
    }

    #[test]
    fn parses_gh_repo_view_with_missing_optionals() {
        // A brand-new repo: no description, never pushed beyond init,
        // zero stars/forks. None of these should crash the parser; the
        // dashboard shows dashes for missing values.
        let fixture = r#"{
            "nameWithOwner": "user/empty",
            "description": null,
            "url": "https://github.com/user/empty",
            "defaultBranchRef": { "name": "main" },
            "stargazerCount": 0,
            "forkCount": 0,
            "pushedAt": null
        }"#;
        let parts = parse_repo_view_json(fixture).expect("parse");
        assert_eq!(parts.repo.as_deref(), Some("user/empty"));
        assert_eq!(parts.description, None);
        assert_eq!(parts.pushed_at, None);
        assert_eq!(parts.stargazer_count, 0);
    }

    #[test]
    fn parses_gh_repo_view_rejects_malformed_json() {
        assert!(parse_repo_view_json("{ broken").is_none());
        assert!(parse_repo_view_json("").is_none());
    }

    #[test]
    fn gh_repo_overview_camel_case_wire_format() {
        // The TS GhRepoOverview interface keys the cache + UI on
        // camelCase; without rename_all the serializer would emit
        // open_prs_count and the frontend would silently read undefined.
        let o = GhRepoOverview {
            gh_available: true,
            repo: Some("a/b".into()),
            description: None,
            url: None,
            default_branch: Some("main".into()),
            stargazer_count: 10,
            fork_count: 2,
            open_issues_count: 5,
            open_prs_count: 1,
            pushed_at: None,
        };
        let json = serde_json::to_value(&o).unwrap();
        assert!(json.get("ghAvailable").is_some());
        assert!(json.get("openIssuesCount").is_some());
        assert!(json.get("openPrsCount").is_some());
        assert!(json.get("stargazerCount").is_some());
        assert!(json.get("forkCount").is_some());
        assert!(json.get("defaultBranch").is_some());
        assert!(json.get("pushedAt").is_some());
        assert!(json.get("open_issues_count").is_none());
    }

    #[tokio::test]
    async fn list_returns_empty_for_non_git_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().to_string();
        let list = git_worktrees(path).await.expect("worktrees");
        assert!(list.is_empty());
    }

    #[test]
    fn worktree_is_dangling_detects_missing_gitdir_target() {
        // A worktree dir whose `.git` file points to a `.git/worktrees/<name>/`
        // entry that was pruned externally — the exact shape this fix
        // exists to recover from. The check must be hermetic (no git
        // invocation) so it runs before `gh auth status` in the status
        // probe.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".git"),
            "gitdir: /var/empty/aethon-test-no-such-worktree-dir\n",
        )
        .expect("write .git");
        assert!(worktree_is_dangling(dir.path()));
    }

    #[test]
    fn worktree_is_dangling_returns_false_for_normal_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        assert!(!worktree_is_dangling(dir.path()));
    }

    #[test]
    fn worktree_is_dangling_returns_false_for_plain_directory() {
        // No `.git` at all — caller is asking about a plain folder, not
        // a worktree. We don't want to mis-label it as "broken".
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(!worktree_is_dangling(dir.path()));
    }

    #[test]
    fn worktree_is_dangling_returns_false_when_gitdir_target_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".git"),
            format!("gitdir: {}\n", target.path().display()),
        )
        .expect("write .git");
        assert!(!worktree_is_dangling(dir.path()));
    }

    #[test]
    fn gh_branch_status_marks_dangling_worktree() {
        // End-to-end on the inner helper. No `gh` invocation, no
        // network — the dangling check must short-circuit before
        // `gh auth status`.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".git"),
            "gitdir: /var/empty/aethon-test-no-such-worktree-dir\n",
        )
        .expect("write .git");
        let s = gh_branch_status_inner(&dir.path().to_string_lossy(), "main");
        assert!(s.worktree_broken, "expected worktree_broken=true");
        assert!(!s.gh_available);
        assert!(s.repo.is_none());
    }

    #[test]
    fn gh_branch_status_does_not_mark_healthy_repo_broken() {
        let dir = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let s = gh_branch_status_inner(&dir.path().to_string_lossy(), "main");
        assert!(!s.worktree_broken);
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
        let listed = git_worktrees(project_path.clone()).await.expect("list");
        assert_eq!(listed.len(), 2);
        git_worktree_remove(project_path.clone(), target_str, false)
            .await
            .expect("worktree remove");
        let after = git_worktrees(project_path).await.expect("list after");
        assert_eq!(after.len(), 1);
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
        assert!(err.contains("main") || err.contains("still tracked"), "got: {err}");
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

    #[test]
    fn url_encode_path_segment_preserves_unreserved() {
        assert_eq!(
            url_encode_path_segment("simple-branch_1.0"),
            "simple-branch_1.0"
        );
    }

    #[test]
    fn url_encode_path_segment_escapes_slashes_and_spaces() {
        assert_eq!(url_encode_path_segment("feat/foo"), "feat%2Ffoo");
        assert_eq!(
            url_encode_path_segment("release/1.2 final"),
            "release%2F1.2%20final"
        );
        assert_eq!(url_encode_path_segment("#hash"), "%23hash");
    }

    #[test]
    fn parse_gh_issue_list_extracts_labels_and_author() {
        let json = r#"
        [
            {
                "number": 1,
                "title": "Crash on launch",
                "url": "https://github.com/o/r/issues/1",
                "state": "OPEN",
                "labels": [
                    {"name": "bug", "color": "ee0701"},
                    {"name": "good first issue"}
                ],
                "updatedAt": "2026-05-22T00:00:00Z",
                "author": {"login": "someone"},
                "comments": 3
            },
            {
                "number": 2,
                "title": "Idea",
                "url": "https://github.com/o/r/issues/2"
            }
        ]
        "#;
        let parsed = parse_gh_issue_list(json);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].number, 1);
        assert_eq!(parsed[0].author.as_deref(), Some("someone"));
        assert_eq!(parsed[0].labels.len(), 2);
        assert_eq!(parsed[0].labels[0].name, "bug");
        assert_eq!(parsed[0].labels[0].color.as_deref(), Some("ee0701"));
        assert_eq!(parsed[0].labels[1].color, None);
        assert_eq!(parsed[0].comments, 3);
        // Second entry: minimal payload (no labels/author/comments)
        // should still produce a row with sensible defaults.
        assert_eq!(parsed[1].number, 2);
        assert!(parsed[1].labels.is_empty());
        assert_eq!(parsed[1].author, None);
        assert_eq!(parsed[1].comments, 0);
    }

    #[test]
    fn parse_gh_issue_list_returns_empty_on_garbage() {
        assert!(parse_gh_issue_list("not json").is_empty());
        assert!(parse_gh_issue_list("{}").is_empty());
        assert!(parse_gh_issue_list("[]").is_empty());
    }
}
