//! File-tree change watcher. The frontend sends the project root plus
//! expanded folders; we maintain a non-recursive watcher per directory
//! and emit `fs-tree-changed` events with a debounced batch of changed
//! directory paths so the UI can refresh exactly the affected nodes.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::Duration;

use tauri::Emitter;

use super::security::{canonical_root, ensure_symlink_safe, validated_target};

struct FsWatchHandle {
    watcher: notify::RecommendedWatcher,
    watched: HashSet<PathBuf>,
}

#[derive(Default)]
pub struct FsWatchState {
    roots: Mutex<HashMap<String, FsWatchHandle>>,
}

#[derive(Clone, serde::Serialize)]
struct FsTreeChanged {
    root: String,
    dirs: Vec<String>,
}

fn is_interesting_fs_event(kind: &notify::EventKind) -> bool {
    use notify::EventKind;
    matches!(
        kind,
        EventKind::Any | EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn changed_dirs_for_paths(root: &Path, paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = HashSet::new();
    for path in paths {
        if !(path == root || path.starts_with(root)) {
            continue;
        }
        let dir = if path.is_dir() {
            path.as_path()
        } else {
            path.parent().unwrap_or(root)
        };
        let dir = if dir == root || dir.starts_with(root) {
            dir
        } else {
            root
        };
        dirs.insert(dir.to_path_buf());
    }
    let mut out: Vec<PathBuf> = dirs.into_iter().collect();
    out.sort();
    out
}

/// Watch the currently-visible file-tree directories for changes. The
/// frontend sends the project root plus expanded folders, so we avoid a
/// recursive whole-repo watcher on large worktrees while still refreshing
/// everything the user can see. Re-calling replaces the watched set for
/// `root`; stale dirs are unwatched, new dirs are added.
#[tauri::command]
pub fn fs_watch_dirs(
    app: tauri::AppHandle,
    state: tauri::State<'_, FsWatchState>,
    root: String,
    dirs: Vec<String>,
) -> Result<usize, String> {
    use notify::{RecursiveMode, Watcher};

    let root_canon = canonical_root(&root)?;
    let mut requested = HashSet::new();
    for dir in dirs {
        let target = validated_target(&root, &dir)?;
        ensure_symlink_safe(&target, &root_canon)?;
        if target.is_dir() {
            requested.insert(target);
        }
    }
    requested.insert(PathBuf::from(&root));

    let mut roots = state.roots.lock().map_err(|e| e.to_string())?;
    let handle = if let Some(handle) = roots.get_mut(&root) {
        handle
    } else {
        let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
        let emit_root = root.clone();
        let emit_root_path = PathBuf::from(&root);
        thread::spawn(move || {
            let mut pending: Vec<PathBuf> = Vec::new();
            while let Ok(paths) = rx.recv() {
                pending.extend(paths);
                while let Ok(paths) = rx.recv_timeout(Duration::from_millis(120)) {
                    pending.extend(paths);
                }
                let dirs = changed_dirs_for_paths(&emit_root_path, &pending);
                pending.clear();
                if dirs.is_empty() {
                    continue;
                }
                let payload = FsTreeChanged {
                    root: emit_root.clone(),
                    dirs: dirs
                        .into_iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect(),
                };
                let _ = app.emit("fs-tree-changed", payload);
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
            let _ = watcher_tx.send(event.paths);
        })
        .map_err(|e| format!("create fs watcher: {e}"))?;
        roots.insert(
            root.clone(),
            FsWatchHandle {
                watcher,
                watched: HashSet::new(),
            },
        );
        roots
            .get_mut(&root)
            .ok_or_else(|| "fs watcher registration failed".to_string())?
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
pub fn fs_unwatch_root(state: tauri::State<'_, FsWatchState>, root: String) -> Result<(), String> {
    let mut roots = state.roots.lock().map_err(|e| e.to_string())?;
    roots.remove(&root);
    Ok(())
}
