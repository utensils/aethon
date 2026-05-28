//! Extension surface: menu items, native app menu, tray, agent
//! file-watcher with debounced reload, and the npm-based extension
//! installer.
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
//!    debounce-backed `notify` watcher that asks each agent child to
//!    drain its prompts and exit; the next IPC call respawns it.
//!    `watch_project_extensions` adds a project-local
//!    `.aethon/extensions/` to the same set when the user opens or
//!    activates a project.
//!
//! `install_aethon_extension` shells out to `npm install --prefix
//! ~/.aethon/extensions`, then deliberately reloads the agent so the new
//! package is loaded on the next request.
//!
//! Submodule layout:
//!
//! - [`menu_items`] — `ExtensionMenuItem`, `ExtensionMenuStore`,
//!   `set_extension_menu_items`
//! - [`app_menu`] — `install_app_menu` (native App menu builder)
//! - [`tray`] — `TRAY_ID`, `install_tray` (status-bar tray)
//! - [`watcher`] — `AgentWatcher`, `start_agent_watcher`
//! - [`reload`] — debounce worker + `reload_request` over stdin
//! - [`project_watch`] — `watch_project_extensions` /
//!   `unwatch_project_extensions`
//! - [`installer`] — `install_aethon_extension`

mod reload;

pub mod app_menu;
pub mod installer;
pub mod menu_items;
pub mod project_watch;
pub mod tray;
pub mod watcher;

// Glob re-exports so `tauri::generate_handler![commands::extensions::…]`
// in `lib.rs` resolves both each command function and the
// macro-generated `__cmd__*` / `__tauri_command_name_*` siblings the
// handler relies on. Same pattern as `shell/mod.rs` and `commands/fs/mod.rs`.
pub use app_menu::*;
pub use installer::*;
pub use menu_items::*;
pub use project_watch::*;
pub use tray::*;
pub use watcher::*;
