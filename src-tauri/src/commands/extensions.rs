//! Extension surface: menu items, native menu + tray rebuild, agent
//! file-watcher, and npm-based extension installer.
//!
//! Two stories live here:
//!
//! 1. **Menu items.** Extensions register entries via `aethon.registerMenuItem`;
//!    the bridge ships an `extension_menu_items` event the frontend forwards
//!    to `set_extension_menu_items`. That command persists the latest list
//!    and rebuilds *both* the App menu and the tray menu so a `location:
//!    "tray"` item actually appears in the status-bar dropdown.
//!
//! 2. **Hot-reload.** The agent's `bun` child is held alive across
//!    Vite reloads, so editing extension or bridge source on its own
//!    wouldn't pick up changes. `start_agent_watcher` runs a
//!    debounce-backed `notify` watcher that kills the child whenever a
//!    qualifying file changes; the next IPC call respawns it.
//!    `watch_project_extensions` adds a project-local
//!    `.aethon/extensions/` to the same set when the user opens or
//!    activates a project.
//!
//! `install_aethon_extension` shells out to `npm install --prefix
//! ~/.aethon/skills`, then deliberately reloads the agent so the new
//! package is loaded on the next request.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    AgentProcess, AgentReloadFlag, agent_reload_in_progress, project_root, resolved_login_path,
};

// ─────────────────────────── menu items ────────────────────────────

/// Extension-registered menu item. Mirrors the shape the bridge ships
/// in `extension_menu_items` events so deserialization is direct.
///
/// `id` and `parent` are part of the wire contract but currently
/// unused by the menu/tray builders below — kept on the struct so the
/// bridge can ship them today and the Rust side can grow into them
/// (nested submenus, id-keyed updates) without breaking the schema.
#[derive(Debug, Clone, Deserialize)]
pub struct ExtensionMenuItem {
    #[allow(dead_code)]
    pub id: String,
    pub label: String,
    pub action: String,
    pub location: String, // "app" | "tray"
    #[allow(dead_code)]
    pub parent: Option<String>,
}

/// App-state container for extension menu items. The bridge can register
/// items at any time; the frontend forwards each delta into
/// `set_extension_menu_items`, which persists the latest list here and
/// rebuilds the native menu.
#[derive(Default)]
pub struct ExtensionMenuStore(pub Mutex<Vec<ExtensionMenuItem>>);

/// Replace the persisted set of extension-registered menu items and
/// rebuild both the App menu and the tray menu so the new entries
/// appear. Idempotent — the frontend re-invokes this on every
/// `extension_menu_items` event from the bridge, including the empty
/// list case (extensions all unregistered).
#[tauri::command]
pub fn set_extension_menu_items(
    items: Vec<ExtensionMenuItem>,
    app: AppHandle,
    store: State<'_, ExtensionMenuStore>,
) -> Result<(), String> {
    {
        let mut guard = store.0.lock().map_err(|e| format!("lock: {e}"))?;
        *guard = items.clone();
    }
    install_app_menu(&app, &items).map_err(|e| format!("install_app_menu: {e}"))?;
    install_tray(&app, &items).map_err(|e| format!("install_tray: {e}"))?;
    Ok(())
}

/// Build and attach the native app menu. The frontend listens for a
/// `menu` Tauri event whose payload is the activated item id; both
/// menu clicks and the existing keyboard shortcuts converge on the
/// same React-side dispatcher. Predefined NS items (Quit, Hide, Cut,
/// Copy, Paste, Minimize, ...) get native behavior automatically.
///
/// `extension_items` carries any `aethon.registerMenuItem` entries from
/// extensions tagged `location: "app"`. They appear under an
/// "Extensions" submenu and emit `menu` events with id `ext:<action>`
/// so the frontend dispatcher can route them via `a2ui_event` to a
/// paired `aethon.onEvent({componentType:"menu-item", descendantId})`
/// matcher.
pub fn install_app_menu(
    app: &AppHandle,
    extension_items: &[ExtensionMenuItem],
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    // M6 restructure: Cmd+T is focus-aware in the webview keydown
    // handler — it spawns an agent tab when focus is outside the bottom
    // terminal panel and a shell sub-tab when focus is inside. The
    // native menu can't observe webview focus, so the menu item
    // triggers an explicit "open new agent tab" action (the unambiguous
    // default users expect from "File → New Tab" everywhere). Cmd+T as
    // an accelerator still exists ONLY on this menu item — when the OS
    // delivers Cmd+T to the menu, the menu fires `new_tab` which the JS
    // router maps to `newTab()` (agent). When the user presses Cmd+T
    // with focus in the panel, the keydown handler intercepts and
    // calls `newShellTab()` instead. To prevent the menu from also
    // firing in that case we'd ideally suppress it via JS, but Tauri's
    // accelerator handling is OS-level — keeping the menu item as the
    // agent-tab path means the worst-case race spawns an agent tab,
    // which is the safer default than a surprise PTY.
    let new_tab = MenuItemBuilder::with_id("new_tab", "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    // Cmd+Shift+T is the explicit "always shell" entry. The webview
    // handler routes it to newShellTab regardless of focus and
    // auto-opens the bottom panel. The menu mirrors that behavior.
    let new_agent_tab = MenuItemBuilder::with_id("new_shell_tab", "New Shell Tab")
        .accelerator("CmdOrCtrl+Shift+T")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("close_tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let next_tab = MenuItemBuilder::with_id("next_tab", "Next Tab")
        .accelerator("CmdOrCtrl+]")
        .build(app)?;
    let prev_tab = MenuItemBuilder::with_id("prev_tab", "Previous Tab")
        .accelerator("CmdOrCtrl+[")
        .build(app)?;
    let toggle_terminal = MenuItemBuilder::with_id("toggle_terminal", "Toggle Terminal")
        .accelerator("CmdOrCtrl+`")
        .build(app)?;
    let clear_chat = MenuItemBuilder::with_id("clear_chat", "Clear Chat")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let stop_prompt = MenuItemBuilder::with_id("stop_prompt", "Stop Current Prompt")
        .accelerator("CmdOrCtrl+.")
        .build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("check_updates", "Check for Updates…").build(app)?;

    // App submenu (macOS-only first slot — Linux/Windows put these in File).
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, "Aethon")
        .item(&PredefinedMenuItem::about(app, Some("About Aethon"), None)?)
        .item(&check_updates)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // Cmd+W is reserved for `close_tab` (browser/IDE convention).
    // Tauri's PredefinedMenuItem::close_window also binds Cmd+W on
    // macOS, so we omit it here — the user closes the window via the
    // red traffic light or Cmd+Q. Adding both would let macOS route
    // Cmd+W to whichever menu item it picks first.
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_tab)
        .item(&new_agent_tab)
        .item(&close_tab)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // On macOS the App submenu owns "Check for Updates…" (HIG-standard
    // location). Non-macOS desktops put it in View since they have no
    // App submenu and stuffing it into File would clash with tab items.
    #[cfg(target_os = "macos")]
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_terminal)
        .item(&clear_chat)
        .item(&stop_prompt)
        .build()?;
    #[cfg(not(target_os = "macos"))]
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_terminal)
        .item(&clear_chat)
        .item(&stop_prompt)
        .separator()
        .item(&check_updates)
        .build()?;

    let tabs_menu = SubmenuBuilder::new(app, "Tabs")
        .item(&new_tab)
        .item(&new_agent_tab)
        .item(&close_tab)
        .separator()
        .item(&next_tab)
        .item(&prev_tab)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let docs_item = MenuItemBuilder::with_id("help_docs", "Aethon Documentation").build(app)?;
    let issues_item = MenuItemBuilder::with_id("help_issues", "Report an Issue…").build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&docs_item)
        .item(&issues_item)
        .build()?;

    // Build the extension submenu. Each extension item id is prefixed
    // with `ext:` so the React-side menu dispatcher can route it to
    // a2ui_event without colliding with built-in ids. Items with
    // `location: "tray"` are deferred to the tray builder below.
    let app_extension_items: Vec<&ExtensionMenuItem> = extension_items
        .iter()
        .filter(|i| i.location == "app")
        .collect();
    let extensions_submenu = if !app_extension_items.is_empty() {
        let mut b = SubmenuBuilder::new(app, "Extensions");
        for item in &app_extension_items {
            let id = format!("ext:{}", item.action);
            let mb = MenuItemBuilder::with_id(&id, &item.label).build(app)?;
            b = b.item(&mb);
        }
        Some(b.build()?)
    } else {
        None
    };

    #[cfg(target_os = "macos")]
    let menu = {
        let mut b = MenuBuilder::new(app)
            .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &tabs_menu]);
        if let Some(ref s) = extensions_submenu {
            b = b.item(s);
        }
        b.items(&[&window_menu, &help_menu]).build()?
    };
    #[cfg(not(target_os = "macos"))]
    let menu = {
        let mut b = MenuBuilder::new(app).items(&[&file_menu, &edit_menu, &view_menu, &tabs_menu]);
        if let Some(ref s) = extensions_submenu {
            b = b.item(s);
        }
        b.items(&[&window_menu, &help_menu]).build()?
    };

    app.set_menu(menu)?;

    // NOTE: `app.on_menu_event` is registered once in `setup()` because
    // Tauri's handler list is additive — calling it here would stack a
    // new closure on every `set_extension_menu_items` invocation, so a
    // single click would fire the React handler N times (the cause of
    // the "Help → Aethon Documentation opens N tabs" bug).

    Ok(())
}

/// Status-bar / tray icon with a tiny menu (Show, New Tab, Quit).
/// Left-click on the icon focuses the main window so users who hide
/// Aethon (Cmd+H) can re-summon it without going through the dock.
/// Reuses the bundled app icon as the tray glyph; macOS gets the
/// template-image treatment so it adapts to dark/light menu bars.
///
/// `extension_items` carries any `aethon.registerMenuItem` entries
/// from extensions tagged `location: "tray"`. They appear after the
/// built-in items and dispatch `menu` events with id `ext:<action>`.
///
/// The tray's `with_id` / `remove_tray_by_id` keys must match — they
/// share `TRAY_ID` so a refactor renaming one doesn't silently break
/// the idempotency contract.
pub const TRAY_ID: &str = "main-tray";

pub fn install_tray(
    app: &AppHandle,
    extension_items: &[ExtensionMenuItem],
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    fn focus_main(app: &AppHandle) {
        // Cmd+H on macOS hides the app at the application level —
        // WebviewWindow::show() doesn't unhide that. AppHandle::show()
        // does. Call it first; on other platforms it's effectively a
        // no-op since GUI apps can't be hidden the same way.
        #[cfg(target_os = "macos")]
        let _ = app.show();
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    let show_item = MenuItem::with_id(app, "tray:show", "Show Aethon", true, None::<&str>)?;
    let new_tab_item = MenuItem::with_id(app, "tray:new_tab", "New Tab", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray:quit", "Quit Aethon", true, None::<&str>)?;
    // Extension-supplied tray items (location: "tray") appear after the
    // built-ins. Each id is prefixed `ext:` so the click handler below
    // can route them through Tauri's `menu` event with the existing
    // dispatcher pattern.
    let mut extension_menu_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    for item in extension_items.iter().filter(|i| i.location == "tray") {
        let id = format!("ext:{}", item.action);
        let mi = MenuItem::with_id(app, &id, &item.label, true, None::<&str>)?;
        extension_menu_items.push(mi);
    }
    // Build the menu's item slice. Mix built-ins with extension entries.
    let mut item_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        vec![&show_item, &new_tab_item, &quit_item];
    for ext in &extension_menu_items {
        item_refs.push(ext);
    }
    let menu = Menu::with_items(app, &item_refs)?;

    let icon = app
        .default_window_icon()
        .ok_or("no default_window_icon — bundle.icon missing?")?
        .clone();

    // Idempotent: remove any prior tray with this id before building.
    // `install_tray` runs at boot AND every time the frontend pushes
    // `extension_menu_items` via `set_extension_menu_items` (so an
    // extension-registered tray entry actually appears in the menu).
    // Without this remove, `TrayIconBuilder.build()` registers a NEW
    // tray each call — and macOS happily shows BOTH icons in the menu
    // bar, which is the user-reported "two Æ icons" bug.
    let _ = app.remove_tray_by_id(TRAY_ID);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        // Show Aethon's full-color logo in the tray rather than a
        // monochrome template. The brand mark (cream Æ + orange π) is
        // recognizable at status-bar size; template rendering would
        // strip the orange and lose the identity.
        .icon_as_template(false)
        // macOS HIG: left-click activates, right-click shows the menu.
        // On Linux/Windows the menu opens on left-click by default,
        // which matches their conventions — leave as the platform default.
        .show_menu_on_left_click(!cfg!(target_os = "macos"))
        .menu(&menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "tray:show" => focus_main(app),
                "tray:new_tab" => {
                    // Forward as a "menu" event so the React side's
                    // existing dispatcher fires the same handler the
                    // app menu's New Tab uses. Bring the window forward
                    // first so the user sees the new tab.
                    focus_main(app);
                    let _ = tauri::Emitter::emit(app, "menu", "new_tab");
                }
                "tray:quit" => app.exit(0),
                other if other.starts_with("ext:") => {
                    // Extension item — bring window forward so the
                    // handler's UI changes are visible, then forward
                    // through the same `menu` event the app menu uses.
                    focus_main(app);
                    let _ = tauri::Emitter::emit(app, "menu", other);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Single left-click = focus window. Anything else (right
            // click, dragging) is left to the menu.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

// ─────────────────────────── agent watcher ────────────────────────────

/// Watch source / extension directories for file changes and kill the
/// running agent child so the next request respawns it with fresh code.
/// Held in Tauri state to keep the watcher thread alive for the app's
/// lifetime.
///
/// Watch paths:
///   - `~/.aethon/extensions/` — user-installed Aethon extensions
///   - `~/.pi/agent/extensions/` — pi extensions (loaded via pi's
///     resourceLoader on session create)
///   - `<project>/agent/` — bridge source, dev only
pub struct AgentWatcher {
    /// The notify watcher itself. Held in `Arc<Mutex<>>` because the
    /// watch list is mutable post-construction — `watch_project_extensions`
    /// adds the active project's `.aethon/extensions/` dir on the fly so a
    /// project the user opens after boot still gets hot-reload.
    watcher: Arc<Mutex<notify::RecommendedWatcher>>,
    /// Currently-watched paths. Exists so `watch_project_extensions` is
    /// idempotent (never double-registers a path) and so unwatch can
    /// dedupe. Bookkeeping mirror of what's actually in the watcher.
    watched: Arc<Mutex<HashSet<PathBuf>>>,
}

struct DebounceMsg {
    settle_ms: u64,
    paths: Vec<PathBuf>,
}

/// Single-thread debounce worker — collapses bursts of file events
/// into one reload request after the channel goes quiet for `settle_ms`.
/// Each new message resets the timeout; the largest settle requested
/// across the burst wins (so a node_modules event that arrives during
/// an extension burst doesn't get prematurely fired).
///
/// Reload mechanism (changed 2026-05): instead of SIGKILLing the bun
/// child mid-prompt — which loses the user's in-flight LLM turn — we
/// send a `{"type":"reload_request"}` line over stdin. The bridge
/// drains active prompts, writes a `_reload_done` sentinel to stdout,
/// and exits cleanly. The supervisor's stdout reader watches for the
/// sentinel and flags the upcoming EOF as an intentional reload so
/// the frontend gets `agent-reloaded` (not `agent-crashed`). The next
/// IPC call lazily respawns with fresh extension state.
fn run_debounce_worker(rx: std::sync::mpsc::Receiver<DebounceMsg>, app: AppHandle) {
    use std::io::Write;
    use std::sync::mpsc::RecvTimeoutError;

    loop {
        // Block until we have at least one event to act on.
        let first = match rx.recv() {
            Ok(m) => m,
            Err(_) => return, // sender dropped — watcher gone
        };
        let mut settle = first.settle_ms;
        let mut last_paths = first.paths;
        // Drain further events until the channel is quiet for `settle` ms.
        loop {
            match rx.recv_timeout(std::time::Duration::from_millis(settle)) {
                Ok(next) => {
                    settle = settle.max(next.settle_ms);
                    last_paths = next.paths;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        // Quiet — ask the bridge to drain & respawn. Holds the child
        // alive (`as_mut`, not `take`) so an in-flight prompt's stdin
        // pipe stays open while pi finishes the turn.
        let state: State<'_, AgentProcess> = app.state();
        if let Ok(mut guard) = state.0.lock()
            && let Some(child) = guard.as_mut()
        {
            // Capture pid before the mutable borrow on `child.stdin`
            // so we can log it without the borrow-checker complaining
            // about overlapping immutable + mutable borrows of `child`.
            let pid = child.id();
            let write_result = match child.stdin.as_mut() {
                Some(stdin) => writeln!(stdin, "{{\"type\":\"reload_request\"}}")
                    .and_then(|_| stdin.flush()),
                None => Err(std::io::Error::other("agent stdin closed")),
            };
            match write_result {
                Ok(()) => {
                    tracing::info!(
                        target: "aethon::agent_watch",
                        "asked pid={pid} to reload after {settle}ms settle (last paths={last_paths:?})",
                    );
                }
                Err(err) => {
                    // Stdin is closed — child is gone or wedged. Fall
                    // back to the legacy hard-kill so the next request
                    // lazily respawns. Mark intentional so the stdout
                    // reader emits agent-reloaded, not agent-crashed.
                    tracing::warn!(
                        target: "aethon::agent_watch",
                        "reload_request write failed for pid={pid}: {err}; falling back to kill",
                    );
                    let reload_flag = agent_reload_in_progress(&app);
                    reload_flag.store(true, std::sync::atomic::Ordering::Release);
                    if let Some(mut dead) = guard.take() {
                        let _ = dead.kill();
                        let _ = dead.wait();
                    }
                    let _ = app.emit("agent-reloaded", "");
                }
            }
        }
    }
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
        // hot-reloads without a manual restart.
        let aethon_ext = h.join(".aethon/extensions");
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
        // ~/.aethon/skills/node_modules holds npm-distributed extension
        // packages (manifest with `aethon` field). On-disk path is
        // retained for back-compat with existing installs. Pre-create so
        // a first `npm install --prefix ~/.aethon/skills <pkg>` triggers
        // a reload without needing to restart the app.
        let skills_modules = h.join(".aethon/skills/node_modules");
        let _ = std::fs::create_dir_all(&skills_modules);
        if skills_modules.exists() {
            watch_paths.push(skills_modules);
        }
        // ~/.aethon/themes holds loose-file JSON themes (no extension /
        // extension packaging required). Pre-create so the first theme drop
        // fires Create events and triggers an agent respawn that picks it
        // up via loadAethonThemeDirectory.
        let themes_dir = h.join(".aethon/themes");
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

// ─────────────────────────── npm installer ────────────────────────────

fn validate_extension_install_spec(spec: &str) -> Result<String, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("extension install spec is required".to_string());
    }
    if trimmed.len() > 512 {
        return Err("extension install spec is too long".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("extension install spec cannot start with '-'".to_string());
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("extension install spec must be a single package or git URL".to_string());
    }
    Ok(trimmed.to_string())
}

fn output_tail(stdout: &[u8], stderr: &[u8]) -> String {
    let mut text = String::new();
    let out = String::from_utf8_lossy(stdout);
    let err = String::from_utf8_lossy(stderr);
    if !out.trim().is_empty() {
        text.push_str(out.trim());
    }
    if !err.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(err.trim());
    }
    const MAX: usize = 4000;
    if text.len() <= MAX {
        text
    } else {
        let mut tail = text.chars().rev().take(MAX).collect::<Vec<_>>();
        tail.reverse();
        tail.into_iter().collect()
    }
}

/// Install an Aethon npm extension package from inside the app. The spec can
/// be a normal npm package name, tarball URL, GitHub shorthand, or git URL —
/// exactly what `npm install <spec>` accepts. Running this in the Tauri shell
/// avoids the agent sidecar being killed mid-install by the existing
/// node_modules watcher. On success we still terminate the current agent so
/// the next request respawns with the freshly installed package loaded.
#[tauri::command]
pub async fn install_aethon_extension(
    spec: String,
    app: AppHandle,
    state: State<'_, AgentProcess>,
    reload_flag: State<'_, AgentReloadFlag>,
) -> Result<String, String> {
    let spec = validate_extension_install_spec(&spec)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let skills_dir = home.join(".aethon").join("skills");
    let install_dir = skills_dir.clone();
    let install_spec = spec.clone();
    let path_override = resolved_login_path();

    let install_result = tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("create {}: {e}", install_dir.display()))?;
        let mut command = Command::new("npm");
        command
            .arg("install")
            .arg("--prefix")
            .arg(&install_dir)
            .arg(&install_spec)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = path_override {
            command.env("PATH", path);
        }
        let output = command
            .output()
            .map_err(|e| format!("npm install failed to start: {e}"))?;
        let tail = output_tail(&output.stdout, &output.stderr);
        if !output.status.success() {
            let status = output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            return Err(format!("npm install exited {status}: {tail}"));
        }
        Ok(tail)
    })
    .await
    .map_err(|e| format!("install task failed: {e}"))?;

    let install_output = install_result?;
    if let Ok(mut guard) = state.0.lock()
        && let Some(mut child) = guard.take()
    {
        let pid = child.id();
        // Mark this kill as intentional BEFORE the actual kill — the
        // stdout reader's EOF handler reads this flag to decide whether
        // to fire `agent-crashed`. Without the flag, the EOF supervisor
        // misclassifies the extension-install reload as a crash and the
        // user sees both a crash toast and the auto-restart on top of
        // the deliberate `agent-reloaded` flow.
        reload_flag
            .0
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = child.kill();
        let _ = child.wait();
        let _ = app.emit("agent-reloaded", "");
        tracing::info!(target: "aethon::ext_install", "killed pid={pid}; will respawn with {spec}");
    }

    Ok(if install_output.trim().is_empty() {
        format!("Installed {spec}")
    } else {
        install_output
    })
}

#[cfg(test)]
mod tests {
    //! Source-level regression tests for the extension menu / tray
    //! rebuild path. Tray idempotency in particular is easier to assert
    //! by structure than by spinning up a Tauri runtime — `mock_app`
    //! isn't currently wired into the crate's test feature.

    use super::TRAY_ID;

    /// The tray id is a single source of truth shared by the build
    /// and the cleanup. If someone changes one without the other, the
    /// idempotency call becomes a no-op and the double-icon bug
    /// returns silently. This test asserts the value hasn't drifted —
    /// any rename should land in both call sites.
    #[test]
    fn tray_id_is_main_tray() {
        assert_eq!(TRAY_ID, "main-tray");
    }

    /// Regression for the "two Æ tray icons" bug.
    ///
    /// `install_tray` is called at boot AND every time the frontend
    /// pushes `extension_menu_items` via `set_extension_menu_items`,
    /// because an extension that registers a `location: "tray"` item
    /// needs the tray rebuilt to appear. Without removing the prior
    /// tray with the same id, `TrayIconBuilder.build` registers a
    /// SECOND OS-level tray (NSStatusItem on macOS) — both icons
    /// stay visible in the menu bar.
    ///
    /// The fix is `app.remove_tray_by_id(TRAY_ID)` before the
    /// builder runs. We assert it's still there: deleting the line
    /// would silently re-introduce the regression and a unit test
    /// catches that at `cargo test --lib` time.
    #[test]
    fn install_tray_calls_remove_tray_by_id_for_idempotency() {
        let src = include_str!("extensions.rs");
        let needle = "remove_tray_by_id(TRAY_ID)";
        assert!(
            src.contains(needle),
            "install_tray must remove the prior tray before rebuilding so calling it twice doesn't leave two OS-level tray icons. Looking for `{needle}` in commands/extensions.rs.",
        );
        // Also assert the call ORDER: the remove must precede the
        // build, not follow it.
        let remove_pos = src.find(needle).unwrap();
        let build_pos = src.find("TrayIconBuilder::with_id(TRAY_ID)").unwrap();
        assert!(
            remove_pos < build_pos,
            "remove_tray_by_id must run BEFORE TrayIconBuilder::with_id, otherwise the new tray gets removed instead of the old one.",
        );
    }

    /// `set_extension_menu_items` is the frontend → Rust path that
    /// rebuilds the menu + tray when an extension registers a menu
    /// item. If it stops calling `install_tray`, the extension item
    /// silently never shows up. If it stops being wired into
    /// `invoke_handler!` (in lib.rs), the frontend invoke fails — the
    /// invoke_handler check lives in the lib.rs source-grep test.
    #[test]
    fn set_extension_menu_items_calls_install_tray() {
        let src = include_str!("extensions.rs");
        assert!(
            src.contains("pub fn set_extension_menu_items("),
            "the Tauri command must exist",
        );
        // It must call install_tray so the rebuild path covers
        // tray entries (location: "tray"), not just the app menu.
        let body_start = src.find("pub fn set_extension_menu_items(").unwrap();
        let body_end = src[body_start..]
            .find("\nfn ")
            .or_else(|| src[body_start..].find("\npub fn "))
            .map(|n| body_start + n)
            .unwrap_or(src.len());
        let body = &src[body_start..body_end];
        assert!(
            body.contains("install_tray("),
            "set_extension_menu_items must call install_tray so location: \"tray\" extension items appear",
        );
    }
}
