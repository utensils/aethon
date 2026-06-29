//! Native menu/tray state: extension-registered menu items, active
//! tray sessions, and the commands that rebuild native surfaces when
//! the frontend pushes a new snapshot.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, State};

use super::app_menu::install_app_menu;
use super::tray::install_tray;

/// Extension-registered menu item. Mirrors the shape the bridge ships
/// in `extension_menu_items` events so deserialization is direct.
///
/// `id` and `parent` are part of the wire contract but currently
/// unused by the menu/tray builders below — kept on the struct so the
/// bridge can ship them today and the Rust side can grow into them
/// (nested submenus, id-keyed updates) without breaking the schema.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ExtensionMenuItem {
    #[allow(dead_code)]
    pub id: String,
    pub label: String,
    pub action: String,
    pub location: String, // "app" | "tray"
    #[allow(dead_code)]
    pub parent: Option<String>,
}

/// Frontend-supplied active agent session row for the tray menu.
/// The Rust side only renders and dispatches the row; session
/// ownership/routing stays in the React project/workspace model.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct TraySessionItem {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    pub active: bool,
    pub running: bool,
    pub needs_attention: bool,
    pub queued_count: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeMenuState {
    pub extension_items: Vec<ExtensionMenuItem>,
    pub tray_sessions: Vec<TraySessionItem>,
}

/// App-state container for native menu/tray inputs. Extension menu
/// replays and session snapshot updates arrive independently, so keep
/// both slices in one mutex and rebuild the affected surface from the
/// combined latest state.
#[derive(Default)]
pub struct ExtensionMenuStore(pub Mutex<NativeMenuState>);

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
    let mut guard = store.0.lock().map_err(|e| format!("lock: {e}"))?;
    if guard.extension_items == items {
        return Ok(());
    }
    install_app_menu(&app, &items).map_err(|e| format!("install_app_menu: {e}"))?;
    install_tray(&app, &items, &guard.tray_sessions).map_err(|e| format!("install_tray: {e}"))?;
    guard.extension_items = items;
    Ok(())
}

/// Replace the active-session rows shown in the tray while preserving
/// extension-registered tray items. The frontend sends a compact
/// snapshot whenever tab/activity state changes.
#[tauri::command]
pub fn set_tray_sessions(
    items: Vec<TraySessionItem>,
    app: AppHandle,
    store: State<'_, ExtensionMenuStore>,
) -> Result<(), String> {
    let mut guard = store.0.lock().map_err(|e| format!("lock: {e}"))?;
    if guard.tray_sessions == items {
        return Ok(());
    }
    install_tray(&app, &guard.extension_items, &items).map_err(|e| format!("install_tray: {e}"))?;
    guard.tray_sessions = items;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! `set_extension_menu_items` is the frontend → Rust path that
    //! rebuilds the menu + tray when an extension registers a menu
    //! item. If it stops calling `install_tray`, the extension item
    //! silently never shows up. If it stops being wired into
    //! `invoke_handler!` (in lib.rs), the frontend invoke fails — the
    //! invoke_handler check lives in the lib.rs source-grep test.

    #[test]
    fn set_extension_menu_items_skips_unchanged_payloads() {
        let src = include_str!("menu_items.rs");
        assert!(
            src.contains("pub fn set_extension_menu_items("),
            "the Tauri command must exist",
        );
        // Workspace creation/project switching can replay an identical
        // extension_menu_items list. That replay must be a no-op so it
        // cannot rebuild native menu/tray state while a prompt is being
        // launched.
        let body_start = src.find("pub fn set_extension_menu_items(").unwrap();
        let body_end = src[body_start..]
            .find("\nfn ")
            .or_else(|| src[body_start..].find("\npub fn "))
            .or_else(|| src[body_start..].find("\n#[cfg(test)]"))
            .map(|n| body_start + n)
            .unwrap_or(src.len());
        let body = &src[body_start..body_end];
        assert!(
            body.contains("if guard.extension_items == items"),
            "set_extension_menu_items must return early when the frontend replays an unchanged menu payload",
        );
        assert!(
            body.contains("install_tray("),
            "changed tray entries still need to reach install_tray so extension items appear",
        );
        let install_pos = body.find("install_tray(").unwrap();
        let store_pos = body.find("guard.extension_items = items").unwrap();
        assert!(
            install_pos < store_pos,
            "the cached payload must be updated only after native menu/tray installation succeeds so retries are not skipped after an error",
        );
    }

    #[test]
    fn set_tray_sessions_preserves_extension_items() {
        let src = include_str!("menu_items.rs");
        let body_start = src.find("pub fn set_tray_sessions(").unwrap();
        let body_end = src[body_start..]
            .find("\nfn ")
            .or_else(|| src[body_start..].find("\npub fn "))
            .or_else(|| src[body_start..].find("\n#[cfg(test)]"))
            .map(|n| body_start + n)
            .unwrap_or(src.len());
        let body = &src[body_start..body_end];
        assert!(
            body.contains("guard.tray_sessions == items"),
            "unchanged tray session snapshots should be skipped",
        );
        assert!(
            body.contains("install_tray(&app, &guard.extension_items, &items)"),
            "session updates must rebuild the tray with the latest extension items",
        );
        assert!(
            body.contains("guard.tray_sessions = items"),
            "the cached tray session snapshot should update after install succeeds",
        );
    }
}
