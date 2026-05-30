//! Git-state watcher. The file-tree watcher in [`crate::commands::fs::watch`]
//! only watches working-tree directories, so git operations that touch *only*
//! `.git/` (commit, stage, branch switch, stash) — especially ones run in an
//! external terminal — never fire `fs-tree-changed`, leaving the file-tree
//! decorations and the `/vcs` slice stale until the next poll or manual
//! refresh.
//!
//! This watcher closes that gap: it resolves the active root's git directory
//! (worktree-aware) and watches `HEAD`/`index`/`refs`/`packed-refs` for
//! changes, emitting a debounced `git-state-changed` event so both surfaces
//! repaint within a couple hundred milliseconds of any git operation.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::Duration;

use tauri::Emitter;

use crate::env;

/// Git writes several files per operation (HEAD, index, a ref, sometimes
/// packed-refs); coalesce a touch longer than the fs watcher's 120ms so a
/// single commit produces one event, not three.
const GIT_DEBOUNCE_MS: u64 = 180;

struct GitWatchHandle {
    #[allow(dead_code)]
    watcher: notify::RecommendedWatcher,
    watched: HashSet<PathBuf>,
}

#[derive(Default)]
pub struct GitWatchState {
    roots: Mutex<HashMap<String, GitWatchHandle>>,
}

#[derive(Clone, serde::Serialize)]
struct GitStateChanged {
    root: String,
}

fn is_interesting_fs_event(kind: &notify::EventKind) -> bool {
    use notify::EventKind;
    matches!(
        kind,
        EventKind::Any | EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

/// Resolve a git path (possibly relative to `root`, as `git rev-parse` emits
/// for a plain checkout) into an absolute path.
fn absolutize(root: &Path, raw: &str) -> PathBuf {
    let p = PathBuf::from(raw.trim());
    if p.is_absolute() { p } else { root.join(p) }
}

/// Resolve the set of directories to watch for git-state changes under `root`.
///
/// Watches (non-recursively, so notify fires on direct children):
/// - the per-worktree git dir — catches `HEAD`, `index`, `MERGE_HEAD`,
///   `ORIG_HEAD`;
/// - the shared common dir — catches `packed-refs`;
/// - `<common>/refs/heads` — catches the branch ref bump on commit / switch.
///
/// For a plain checkout the git dir and common dir are the same `.git`, so the
/// result dedupes to `{.git, .git/refs/heads}`. For a linked worktree they
/// differ — the per-worktree dir holds HEAD/index while refs live in the shared
/// dir — which is the case that actually breaks today. Non-existent paths are
/// dropped so `notify::watch` never errors on them.
fn resolve_git_watch_targets(root: &Path) -> Vec<PathBuf> {
    let out = env::command("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--git-dir", "--git-common-dir"])
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let git_dir = lines.next().map(|l| absolutize(root, l));
    // `--git-common-dir` echoes the git dir verbatim when there's no separate
    // common dir, so a missing second line falls back to the git dir.
    let common_dir = lines
        .next()
        .map(|l| absolutize(root, l))
        .or_else(|| git_dir.clone());

    let mut targets: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if p.is_dir() && !targets.contains(&p) {
            targets.push(p);
        }
    };
    if let Some(dir) = git_dir {
        push(dir);
    }
    if let Some(common) = common_dir {
        push(common.join("refs").join("heads"));
        push(common);
    }
    targets
}

/// Watch the active project/worktree's git directory for state changes. Emits a
/// debounced `git-state-changed` event keyed by `root`. Re-calling replaces the
/// watcher for `root`. A root whose git dir can't be resolved (not a repo) is a
/// no-op, mirroring the silent-degrade contract of the status commands.
#[tauri::command]
pub fn git_watch_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, GitWatchState>,
    root: String,
) -> Result<usize, String> {
    use notify::{RecursiveMode, Watcher};

    let targets = resolve_git_watch_targets(Path::new(&root));
    let mut roots = state.roots.lock().map_err(|e| e.to_string())?;
    if targets.is_empty() {
        // Not a git repo (or git missing): drop any stale handle and bail.
        roots.remove(&root);
        return Ok(0);
    }
    let requested: HashSet<PathBuf> = targets.into_iter().collect();

    let handle = if let Some(handle) = roots.get_mut(&root) {
        handle
    } else {
        let (tx, rx) = mpsc::channel::<()>();
        let emit_root = root.clone();
        thread::spawn(move || {
            // Block until the first event, then coalesce a burst so a single
            // git operation emits one `git-state-changed`.
            while rx.recv().is_ok() {
                while rx
                    .recv_timeout(Duration::from_millis(GIT_DEBOUNCE_MS))
                    .is_ok()
                {}
                let _ = app.emit(
                    "git-state-changed",
                    GitStateChanged {
                        root: emit_root.clone(),
                    },
                );
            }
        });

        let watcher_tx = tx.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else {
                return;
            };
            if !is_interesting_fs_event(&event.kind) {
                return;
            }
            let _ = watcher_tx.send(());
        })
        .map_err(|e| format!("create git watcher: {e}"))?;
        roots.insert(
            root.clone(),
            GitWatchHandle {
                watcher,
                watched: HashSet::new(),
            },
        );
        roots
            .get_mut(&root)
            .ok_or_else(|| "git watcher registration failed".to_string())?
    };

    let stale: Vec<PathBuf> = handle.watched.difference(&requested).cloned().collect();
    for dir in stale {
        let _ = handle.watcher.unwatch(&dir);
        handle.watched.remove(&dir);
    }
    for dir in &requested {
        if handle.watched.contains(dir) {
            continue;
        }
        handle
            .watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|e| format!("watch {}: {e}", dir.display()))?;
        handle.watched.insert(dir.clone());
    }

    Ok(handle.watched.len())
}

#[tauri::command]
pub fn git_unwatch_root(
    state: tauri::State<'_, GitWatchState>,
    root: String,
) -> Result<(), String> {
    let mut roots = state.roots.lock().map_err(|e| e.to_string())?;
    roots.remove(&root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::git::test_support::init_repo;

    fn canon(p: &Path) -> PathBuf {
        std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
    }

    #[test]
    fn resolves_plain_checkout_targets() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(root);

        let targets: Vec<PathBuf> = resolve_git_watch_targets(root)
            .into_iter()
            .map(|p| canon(&p))
            .collect();

        let git_dir = canon(&root.join(".git"));
        let refs_heads = canon(&root.join(".git/refs/heads"));
        assert!(
            targets.contains(&git_dir),
            "plain checkout should watch .git (HEAD/index); got {targets:?}"
        );
        assert!(
            targets.contains(&refs_heads),
            "plain checkout should watch .git/refs/heads; got {targets:?}"
        );
    }

    #[test]
    fn resolves_worktree_targets_to_per_worktree_and_shared_dirs() {
        // Keep both the main checkout and the linked worktree inside one
        // tempdir so the worktree path is unique per run and auto-cleaned —
        // a sibling in shared /tmp would leak and collide across parallel
        // `cargo test` runs.
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        std::fs::create_dir(&main).unwrap();
        let main = main.as_path();
        init_repo(main);

        // Create a linked worktree on a new branch — `.git` there is a *file*
        // pointing at `<main>/.git/worktrees/<name>`, with HEAD/index local and
        // refs shared. This is the screenshot's exact case.
        let wt = tmp.path().join("wt-feature");
        let add = std::process::Command::new("git")
            .arg("-C")
            .arg(main)
            .args(["worktree", "add", "-q", "-b", "feature"])
            .arg(&wt)
            .status()
            .expect("git worktree add");
        assert!(add.success(), "worktree add failed: {add}");

        let targets: Vec<PathBuf> = resolve_git_watch_targets(&wt)
            .into_iter()
            .map(|p| canon(&p))
            .collect();

        let per_worktree = canon(&main.join(".git/worktrees/wt-feature"));
        let shared = canon(&main.join(".git"));
        let shared_refs = canon(&main.join(".git/refs/heads"));
        assert!(
            targets.contains(&per_worktree),
            "worktree should watch its own git dir (HEAD/index); got {targets:?}"
        );
        assert!(
            targets.contains(&shared),
            "worktree should watch the shared common dir (packed-refs); got {targets:?}"
        );
        assert!(
            targets.contains(&shared_refs),
            "worktree should watch shared refs/heads; got {targets:?}"
        );
    }

    #[test]
    fn non_repo_resolves_to_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(resolve_git_watch_targets(tmp.path()).is_empty());
    }
}
