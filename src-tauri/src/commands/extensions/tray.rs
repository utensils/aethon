//! Status-bar / tray icon. Left-click focuses the main window; the
//! menu carries Show / New Tab / Quit plus any `location: "tray"`
//! extension items. Runtime updates keep the existing status item and
//! replace only its menu, avoiding macOS `NSStatusItem` recreation
//! while workspace/project switches are in flight.

use tauri::AppHandle;

use super::menu_items::ExtensionMenuItem;

/// The tray's `with_id` / `remove_tray_by_id` keys must match — they
/// share `TRAY_ID` so a refactor renaming one doesn't silently break
/// the idempotency contract.
pub const TRAY_ID: &str = "main-tray";

/// Status-bar / tray icon with a tiny menu (Show, New Tab, Quit).
/// Left-click on the icon focuses the main window so users who hide
/// Aethon (Cmd+H) can re-summon it without going through the dock.
/// Reuses the bundled app icon as the tray glyph; macOS gets the
/// template-image treatment so it adapts to dark/light menu bars.
///
/// `extension_items` carries any `aethon.registerMenuItem` entries
/// from extensions tagged `location: "tray"`. They appear after the
/// built-in items and dispatch `menu` events with id `ext:<action>`.
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

    // Boot creates the status item once. Runtime menu updates (for
    // extension_menu_items replays during project/workspace switches)
    // must not remove/recreate the macOS NSStatusItem: hang reports
    // show AppKit blocking inside NSStatusBar::statusItemWithLength
    // when that happens while a prompt/workspace launch is in flight.
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
        return Ok(());
    }

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        // Show Aethon's full-color logo in the tray rather than a
        // monochrome template. The brand mark (cream Æ + orange π) is
        // recognizable at status-bar size; template rendering would
        // strip the orange and lose the identity.
        .icon_as_template(false)
        // Left + right click both open the menu — matches Linux / Windows
        // out of the box and makes the macOS tray icon discoverable.
        // (The earlier macOS-only left-click-to-activate handler felt
        // broken to users because nothing visible happened.)
        .show_menu_on_left_click(true)
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

#[cfg(test)]
mod tests {
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

    /// Regression for the workspace-switch hang captured in
    /// `Aethon-crash.txt`.
    ///
    /// Project/workspace switches replay `extension_menu_items`. The
    /// old implementation made every replay remove and recreate the
    /// macOS `NSStatusItem`, and the hang report shows AppKit blocking
    /// inside `NSStatusBar::statusItemWithLength` during that rebuild.
    /// Runtime updates must keep the existing tray icon and replace
    /// only its menu; the builder should run only when the tray does
    /// not exist yet (boot / recovery path).
    #[test]
    fn install_tray_updates_existing_tray_instead_of_recreating_it() {
        let src = include_str!("tray.rs");
        let src = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let lookup = "tray_by_id(TRAY_ID)";
        let update = "tray.set_menu(Some(menu))";
        let build = "TrayIconBuilder::with_id(TRAY_ID)";
        assert!(
            src.contains(lookup),
            "install_tray must look up the existing tray before attempting to build a new NSStatusItem",
        );
        assert!(
            src.contains(update),
            "install_tray must update the existing tray menu instead of recreating the status item",
        );
        let lookup_pos = src.find(lookup).unwrap();
        let build_pos = src.find(build).unwrap();
        assert!(
            lookup_pos < build_pos,
            "install_tray must check for an existing tray before TrayIconBuilder::with_id runs",
        );
        assert!(
            !src.contains("remove_tray_by_id("),
            "runtime tray updates must not remove/recreate the macOS status item",
        );
    }
}
