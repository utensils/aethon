//! Status-bar / tray icon. Left-click focuses the main window; the
//! menu carries Show, active agent sessions, utility actions, extension
//! tray items, and Quit. Runtime updates keep the existing status item
//! and replace only its menu, avoiding macOS `NSStatusItem` recreation
//! while workspace/project switches are in flight.

use tauri::AppHandle;

use super::menu_items::{ExtensionMenuItem, TraySessionItem};

/// The tray's `with_id` / `remove_tray_by_id` keys must match — they
/// share `TRAY_ID` so a refactor renaming one doesn't silently break
/// the idempotency contract.
pub const TRAY_ID: &str = "main-tray";

/// Status-bar / tray icon with a session-aware menu.
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
    session_items: &[TraySessionItem],
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
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

    fn trim_menu_text(input: &str, max_chars: usize) -> String {
        let text = input.trim();
        if text.chars().count() <= max_chars {
            return text.to_string();
        }
        let mut out: String = text.chars().take(max_chars.saturating_sub(3)).collect();
        out.push_str("...");
        out
    }

    fn session_label(item: &TraySessionItem) -> String {
        let mut label = trim_menu_text(&item.label, 56);
        let mut prefix = "";
        if item.running {
            prefix = "[running] ";
        } else if item.needs_attention {
            prefix = "[new] ";
        } else if item.active {
            prefix = "[current] ";
        } else if item.queued_count > 0 {
            prefix = "[queued] ";
        }
        if !prefix.is_empty() {
            label = format!("{prefix}{label}");
        }
        if let Some(detail) = item.detail.as_ref().filter(|d| !d.trim().is_empty()) {
            label.push_str(" - ");
            label.push_str(&trim_menu_text(detail, 28));
        }
        if item.queued_count > 0 {
            label.push_str(&format!(" ({})", item.queued_count));
        }
        label
    }

    let show_item = MenuItem::with_id(app, "tray:show", "Show Aethon", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray:quit", "Quit Aethon", true, None::<&str>)?;
    let sessions_header = MenuItem::with_id(
        app,
        "tray:sessions_header",
        "Active Sessions",
        false,
        None::<&str>,
    )?;
    let no_sessions = MenuItem::with_id(
        app,
        "tray:no_sessions",
        "No open agent sessions",
        false,
        None::<&str>,
    )?;
    let scheduled_tasks = MenuItem::with_id(
        app,
        "tray:scheduled_tasks",
        "Scheduled Tasks...",
        true,
        None::<&str>,
    )?;
    let manage_extensions = MenuItem::with_id(
        app,
        "tray:manage_extensions",
        "Manage Extensions...",
        true,
        None::<&str>,
    )?;
    let check_updates = MenuItem::with_id(
        app,
        "tray:check_updates",
        "Check for Updates...",
        true,
        None::<&str>,
    )?;
    let sep_after_show = PredefinedMenuItem::separator(app)?;
    let sep_after_sessions = PredefinedMenuItem::separator(app)?;
    let sep_before_extensions = PredefinedMenuItem::separator(app)?;
    let sep_before_quit = PredefinedMenuItem::separator(app)?;

    let visible_sessions = session_items.iter().take(10);
    let mut session_menu_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    for item in visible_sessions {
        let id = format!("tray:session:{}", item.id);
        session_menu_items.push(MenuItem::with_id(
            app,
            &id,
            session_label(item),
            true,
            None::<&str>,
        )?);
    }
    let more_sessions = if session_items.len() > session_menu_items.len() {
        Some(MenuItem::with_id(
            app,
            "tray:more_sessions",
            format!(
                "+{} more in Aethon",
                session_items.len() - session_menu_items.len()
            ),
            false,
            None::<&str>,
        )?)
    } else {
        None
    };
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
    // Build the menu's item slice. Mix built-ins with dynamic session
    // rows and extension entries.
    let mut item_refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
        vec![&show_item, &sep_after_show, &sessions_header];
    if session_menu_items.is_empty() {
        item_refs.push(&no_sessions);
    } else {
        for session in &session_menu_items {
            item_refs.push(session);
        }
    }
    if let Some(more) = &more_sessions {
        item_refs.push(more);
    }
    item_refs.push(&sep_after_sessions);
    item_refs.push(&scheduled_tasks);
    item_refs.push(&manage_extensions);
    item_refs.push(&check_updates);
    if !extension_menu_items.is_empty() {
        item_refs.push(&sep_before_extensions);
    }
    for ext in &extension_menu_items {
        item_refs.push(ext);
    }
    item_refs.push(&sep_before_quit);
    item_refs.push(&quit_item);
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
                "tray:scheduled_tasks" => {
                    focus_main(app);
                    let _ = tauri::Emitter::emit(app, "menu", "scheduled_tasks");
                }
                "tray:manage_extensions" => {
                    focus_main(app);
                    let _ = tauri::Emitter::emit(app, "menu", "manage_extensions");
                }
                "tray:check_updates" => {
                    focus_main(app);
                    let _ = tauri::Emitter::emit(app, "menu", "check_updates");
                }
                "tray:quit" => app.exit(0),
                other if other.starts_with("tray:session:") => {
                    focus_main(app);
                    let _ = tauri::Emitter::emit(app, "menu", other);
                }
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

    #[test]
    fn tray_menu_no_longer_exposes_new_tab() {
        let src = include_str!("tray.rs");
        let src = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        assert!(
            !src.contains("tray:new_tab"),
            "the tray is a session switcher/status surface; New Tab stays in app chrome and the menu bar",
        );
        assert!(
            src.contains("tray:session:"),
            "active session rows should route through tray:session:<tabId>",
        );
    }
}
