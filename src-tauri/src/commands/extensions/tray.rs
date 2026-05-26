//! Status-bar / tray icon. Left-click focuses the main window; the
//! menu carries Show / New Tab / Quit plus any `location: "tray"`
//! extension items. Idempotent across `set_extension_menu_items`
//! pushes — the same `TRAY_ID` is used to remove the prior tray
//! before rebuilding.

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
        let src = include_str!("tray.rs");
        let needle = "remove_tray_by_id(TRAY_ID)";
        assert!(
            src.contains(needle),
            "install_tray must remove the prior tray before rebuilding so calling it twice doesn't leave two OS-level tray icons. Looking for `{needle}` in commands/extensions/tray.rs.",
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
}
