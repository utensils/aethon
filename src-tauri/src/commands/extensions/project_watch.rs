//! Project-local extension watcher add/remove. The user-level and
//! pi-level extension dirs are wired into `start_agent_watcher` at
//! boot; each project's `.aethon/extensions/` is registered on demand
//! when the user opens or activates the project.

use std::path::PathBuf;

use tauri::State;

use super::watcher::AgentWatcher;

/// Add a project's `.aethon/extensions/` dir to the watch list so edits
/// fire the same kill-and-respawn flow as edits in `~/.aethon/extensions/`.
/// Idempotent — re-adding a watched path is a no-op. Called by the frontend
/// after the user opens or activates a project; without this the only
/// hot-reloaded extension dirs are the user-level + extension-package ones, and a
/// project's `.aethon/extensions/` requires a manual agent restart.
#[tauri::command]
pub fn watch_project_extensions(
    state: State<'_, AgentWatcher>,
    project_path: String,
) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};
    let project = PathBuf::from(&project_path);
    let ext_dir = project.join(".aethon").join("extensions");
    if !ext_dir.exists() {
        // Pre-create so the first extension drop fires Create events
        // and the watcher already has the path in scope. Same logic as
        // ~/.aethon/extensions at boot.
        let _ = std::fs::create_dir_all(&ext_dir);
    }
    if !ext_dir.exists() {
        return Err(format!("cannot watch {}: dir missing", ext_dir.display()));
    }
    let mut watched = state.watched.lock().map_err(|e| e.to_string())?;
    if watched.contains(&ext_dir) {
        return Ok(()); // already watching
    }
    let mut watcher = state.watcher.lock().map_err(|e| e.to_string())?;
    watcher
        .watch(&ext_dir, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {}: {e}", ext_dir.display()))?;
    watched.insert(ext_dir.clone());
    tracing::info!(target: "aethon::agent_watch", "now watching project ext dir {}", ext_dir.display());
    Ok(())
}

/// Drop a previously-watched project extensions dir. Called by the
/// frontend when the user removes a project or switches to a different
/// active project. Missing paths are silently ignored.
#[tauri::command]
pub fn unwatch_project_extensions(
    state: State<'_, AgentWatcher>,
    project_path: String,
) -> Result<(), String> {
    use notify::Watcher;
    let project = PathBuf::from(&project_path);
    let ext_dir = project.join(".aethon").join("extensions");
    let mut watched = state.watched.lock().map_err(|e| e.to_string())?;
    if !watched.contains(&ext_dir) {
        return Ok(());
    }
    let mut watcher = state.watcher.lock().map_err(|e| e.to_string())?;
    let _ = watcher.unwatch(&ext_dir);
    watched.remove(&ext_dir);
    tracing::info!(target: "aethon::agent_watch", "stopped watching project ext dir {}", ext_dir.display());
    Ok(())
}
