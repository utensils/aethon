//! File-system watcher for extension / agent source directories. On a
//! qualifying event (Modify/Create/Remove of `.ts|.tsx|.js|.mjs|.json`)
//! we push a [`DebounceMsg`] to the [reload worker][`super::reload`],
//! which coalesces bursts and asks each live agent child to reload.
//!
//! Watch paths:
//!   - `~/.aethon/extensions/` — user-installed Aethon extensions
//!   - `~/.pi/agent/extensions/` — pi extensions (loaded via pi's
//!     resourceLoader on session create)
//!   - `~/.pi/agent/skills/` — pi skills (slash commands)
//!   - `~/.aethon/extensions/node_modules/` — npm-distributed extensions
//!   - `~/.aethon/themes/` — loose-file JSON themes
//!   - `<project>/agent/` — bridge source, dev only

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

use crate::agent_process::project_root;

use super::reload::{DebounceMsg, run_debounce_worker};

/// State container for the agent watcher. Held in Tauri state to keep
/// the watcher thread alive for the app's lifetime.
pub struct AgentWatcher {
    /// The notify watcher itself. Held in `Arc<Mutex<>>` because the
    /// watch list is mutable post-construction — `watch_project_extensions`
    /// adds the active project's `.aethon/extensions/` dir on the fly so a
    /// project the user opens after boot still gets hot-reload.
    pub(super) watcher: Arc<Mutex<notify::RecommendedWatcher>>,
    /// Currently-watched paths. Exists so `watch_project_extensions` is
    /// idempotent (never double-registers a path) and so unwatch can
    /// dedupe. Bookkeeping mirror of what's actually in the watcher.
    pub(super) watched: Arc<Mutex<HashSet<PathBuf>>>,
}

pub fn start_agent_watcher(app: AppHandle) -> Option<AgentWatcher> {
    use notify::event::{DataChange, ModifyKind};
    use notify::{EventKind, RecursiveMode, Watcher};

    // Compose the watch list. Each path is included only if it exists
    // — missing extension dirs are normal for fresh installs.
    let home = app.path().home_dir().ok();
    let mut watch_paths: Vec<PathBuf> = Vec::new();
    if let Some(h) = home {
        // ~/.aethon/extensions belongs to us — create it on boot so a
        // first-time extension drop fires Create events and the agent
        // hot-reloads without a manual restart. `helpers::aethon_dir`
        // honors the `AETHON_USER_DIR` override so `dev.sh --new` lands
        // the sandboxed extensions in the per-PID tmp tree.
        let aethon_root =
            crate::helpers::aethon_dir(Some(h.clone())).unwrap_or_else(|| h.join(".aethon"));
        let aethon_ext = aethon_root.join("extensions");
        let _ = std::fs::create_dir_all(&aethon_ext);
        if aethon_ext.exists() {
            watch_paths.push(aethon_ext);
        }
        // ~/.pi/agent/extensions is pi's territory but Aethon needs to
        // watch it so an extension dropped in there hot-reloads without a
        // manual app restart. Pre-create the directory if missing so the
        // watcher fires Create events on the first installed extension.
        // Failure is non-fatal — pi's installer will create it later and
        // the next app launch will pick it up.
        let pi_ext = h.join(".pi/agent/extensions");
        let _ = std::fs::create_dir_all(&pi_ext);
        if pi_ext.exists() {
            watch_paths.push(pi_ext);
        }
        // ~/.pi/agent/skills holds pi skills that users expect to invoke
        // as slash commands. Watch it too so installing a SKILL.md refreshes
        // the bridge's ready payload and the composer autocomplete.
        let pi_skills = h.join(".pi/agent/skills");
        let _ = std::fs::create_dir_all(&pi_skills);
        if pi_skills.exists() {
            watch_paths.push(pi_skills);
        }
        // ~/.aethon/extensions/node_modules holds npm-distributed extension
        // packages (manifest with `aethon` field). Pre-create so
        // a first `npm install --prefix ~/.aethon/extensions <pkg>` triggers
        // a reload without needing to restart the app.
        let extension_modules = aethon_root.join("extensions").join("node_modules");
        let _ = std::fs::create_dir_all(&extension_modules);
        if extension_modules.exists() {
            watch_paths.push(extension_modules);
        }
        // ~/.aethon/themes holds loose-file JSON themes (no extension /
        // extension packaging required). Pre-create so the first theme drop
        // fires Create events and triggers an agent respawn that picks it
        // up via loadAethonThemeDirectory.
        let themes_dir = aethon_root.join("themes");
        let _ = std::fs::create_dir_all(&themes_dir);
        if themes_dir.exists() {
            watch_paths.push(themes_dir);
        }
    }
    // Bridge source dir is dev-only — release ships a compiled sidecar
    // and editing the source has no effect on the running binary.
    if cfg!(debug_assertions) {
        let agent_dir = project_root().join("agent");
        if agent_dir.exists() {
            watch_paths.push(agent_dir);
        }
    }
    if watch_paths.is_empty() {
        tracing::warn!(target: "aethon::agent_watch", "nothing to watch — hot reload disabled");
        return None;
    }

    // Trailing-edge debounce backed by a single worker thread (NOT
    // one thread per event). The watcher posts each qualifying event
    // through a channel; the worker's `recv_timeout` resets on each
    // arrival and only fires the kill when the channel goes quiet for
    // the configured settle window. npm install bursts produce
    // thousands of events; spawning a thread per event would exhaust
    // OS resources on the very scenario this is supposed to handle.
    let app_clone = app.clone();
    let (debounce_tx, debounce_rx) = std::sync::mpsc::channel::<DebounceMsg>();
    std::thread::spawn(move || run_debounce_worker(debounce_rx, app_clone.clone()));

    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let event = match res {
                Ok(ev) => ev,
                Err(err) => {
                    tracing::warn!(target: "aethon::agent_watch", "error: {err}");
                    return;
                }
            };

            // Only react to actual content writes — `Modify(Data(_))` is the
            // editor-saved-the-file event. Everything else (metadata, opens,
            // creates from build-tool atime updates, etc.) is ignored to
            // avoid spurious respawns at app startup.
            let is_data_modify = matches!(
                event.kind,
                EventKind::Modify(ModifyKind::Data(DataChange::Any | DataChange::Content))
            );
            // Some platforms (macOS fsevents) report renames from atomic
            // editors as `Modify(Name(_))`. Treat those as content changes too.
            let is_atomic_rename = matches!(event.kind, EventKind::Modify(ModifyKind::Name(_)));
            // Extensions land in their watched dirs as a Create event when
            // the user copies a new file in. Treat those as reload triggers.
            let is_create = matches!(event.kind, EventKind::Create(_));
            // Removing an extension should also trigger reload so the
            // bridge stops loading it on the next spawn.
            let is_remove = matches!(event.kind, EventKind::Remove(_));

            if !(is_data_modify || is_atomic_rename || is_create || is_remove) {
                return;
            }

            // Only kill on changes to source files we actually care about.
            let touched_source = event.paths.iter().any(|p| {
                matches!(
                    p.extension().and_then(|s| s.to_str()),
                    Some("ts" | "tsx" | "json" | "mjs" | "js")
                )
            });
            if !touched_source {
                return;
            }

            // node_modules events get a longer settle window because
            // npm install can produce IO bursts spaced out beyond the
            // editor-save scale. Edits in agent/ or extension dirs
            // use a tighter window so the dev cycle stays snappy.
            let in_node_modules = event.paths.iter().any(|p| {
                p.components()
                    .any(|c| matches!(c.as_os_str().to_str(), Some("node_modules")))
            });
            let settle_ms: u64 = if in_node_modules { 3000 } else { 1000 };
            let _ = debounce_tx.send(DebounceMsg {
                settle_ms,
                paths: event.paths.clone(),
            });
        }) {
            Ok(w) => w,
            Err(err) => {
                tracing::error!(target: "aethon::agent_watch", "failed to create watcher: {err}");
                return None;
            }
        };

    let mut watching: HashSet<PathBuf> = HashSet::new();
    for path in &watch_paths {
        if let Err(err) = watcher.watch(path, RecursiveMode::Recursive) {
            tracing::warn!(target: "aethon::agent_watch", "failed to watch {}: {err}", path.display());
        } else {
            watching.insert(path.clone());
        }
    }
    if watching.is_empty() {
        return None;
    }

    tracing::info!(
        target: "aethon::agent_watch",
        "watching {} dir(s) for changes: {}",
        watching.len(),
        watching
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    );
    Some(AgentWatcher {
        watcher: Arc::new(Mutex::new(watcher)),
        watched: Arc::new(Mutex::new(watching)),
    })
}
