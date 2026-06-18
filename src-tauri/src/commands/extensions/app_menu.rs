//! Native application menu. Built from the static set of Aethon
//! actions plus any `location: "app"` extension items pushed via
//! `set_extension_menu_items`. The frontend dispatcher listens for
//! Tauri `menu` events whose payload is the activated item id.

use tauri::AppHandle;

use super::menu_items::ExtensionMenuItem;

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
    // Editor file operations. The accelerators land on the menu at the OS
    // level (macOS routes Cmd+S/Cmd+N to the menu before the webview), so
    // the React menu dispatcher forwards them to the active editor via
    // window events. New File reuses the file tree's create flow.
    let new_file = MenuItemBuilder::with_id("new_file", "New File…")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let save_file = MenuItemBuilder::with_id("save_file", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let revert_file = MenuItemBuilder::with_id("revert_file", "Revert File").build(app)?;
    let next_tab = MenuItemBuilder::with_id("next_tab", "Next Tab")
        .accelerator("CmdOrCtrl+Shift+]")
        .build(app)?;
    let prev_tab = MenuItemBuilder::with_id("prev_tab", "Previous Tab")
        .accelerator("CmdOrCtrl+Shift+[")
        .build(app)?;
    let toggle_terminal = MenuItemBuilder::with_id("toggle_terminal", "Toggle Terminal")
        .accelerator("CmdOrCtrl+`")
        .build(app)?;
    let toggle_files = MenuItemBuilder::with_id("toggle_files", "Toggle Files")
        .accelerator("CmdOrCtrl+J")
        .build(app)?;
    let toggle_files_sidebar =
        MenuItemBuilder::with_id("toggle_files_sidebar", "Toggle Files Sidebar")
            .accelerator("CmdOrCtrl+D")
            .build(app)?;
    let clear_chat = MenuItemBuilder::with_id("clear_chat", "Clear Chat")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let stop_prompt = MenuItemBuilder::with_id("stop_prompt", "Stop Current Prompt")
        .accelerator("CmdOrCtrl+.")
        .build(app)?;
    // Shift+Tab is handled in the webview so it can remain focus-aware
    // and pass through to the terminal panel. The native menu item is
    // still present for discoverability and pointer access.
    let toggle_plan_mode =
        MenuItemBuilder::with_id("toggle_plan_mode", "Toggle Plan Mode").build(app)?;
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
    #[cfg(target_os = "macos")]
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_file)
        .item(&save_file)
        .item(&revert_file)
        .separator()
        .item(&new_tab)
        .item(&new_agent_tab)
        .item(&close_tab)
        .build()?;
    #[cfg(not(target_os = "macos"))]
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_file)
        .item(&save_file)
        .item(&revert_file)
        .separator()
        .item(&new_tab)
        .item(&new_agent_tab)
        .item(&close_tab)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Exit"))?)
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
        .item(&toggle_files)
        .item(&toggle_files_sidebar)
        .item(&clear_chat)
        .item(&stop_prompt)
        .item(&toggle_plan_mode)
        .build()?;
    #[cfg(not(target_os = "macos"))]
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_terminal)
        .item(&toggle_files)
        .item(&toggle_files_sidebar)
        .item(&clear_chat)
        .item(&stop_prompt)
        .item(&toggle_plan_mode)
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

    // Build the extension submenu. The first item is a built-in escape
    // hatch for managing/disable toggling extensions even when an old
    // extension has broken the rendered workspace. Extension-provided
    // item ids are prefixed with `ext:` so the React-side menu dispatcher
    // can route them to a2ui_event without colliding with built-in ids.
    // Items with `location: "tray"` are deferred to the tray builder below.
    let app_extension_items: Vec<&ExtensionMenuItem> = extension_items
        .iter()
        .filter(|i| i.location == "app")
        .collect();
    let manage_extensions =
        MenuItemBuilder::with_id("manage_extensions", "Manage Extensions…").build(app)?;
    let mut extensions_builder = SubmenuBuilder::new(app, "Extensions").item(&manage_extensions);
    if !app_extension_items.is_empty() {
        extensions_builder = extensions_builder.separator();
    }
    for item in &app_extension_items {
        let id = format!("ext:{}", item.action);
        let mb = MenuItemBuilder::with_id(&id, &item.label).build(app)?;
        extensions_builder = extensions_builder.item(&mb);
    }
    let extensions_submenu = extensions_builder.build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        let mut b = MenuBuilder::new(app)
            .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &tabs_menu]);
        b = b.item(&extensions_submenu);
        b.items(&[&window_menu, &help_menu]).build()?
    };
    #[cfg(not(target_os = "macos"))]
    let menu = {
        let mut b = MenuBuilder::new(app).items(&[&file_menu, &edit_menu, &view_menu, &tabs_menu]);
        b = b.item(&extensions_submenu);
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

#[cfg(test)]
mod tests {
    /// Extensions can break the rendered workspace itself, so the app
    /// menu must always keep a built-in management entry available
    /// outside extension-controlled UI. Extension-provided items are
    /// additive; they must not be the condition for showing the menu.
    #[test]
    fn app_menu_always_exposes_extension_management() {
        let src = include_str!("app_menu.rs");
        assert!(
            src.contains("MenuItemBuilder::with_id(\"manage_extensions\", \"Manage Extensions…\")"),
            "the app menu needs a built-in Manage Extensions item",
        );
        assert!(
            src.contains("SubmenuBuilder::new(app, \"Extensions\").item(&manage_extensions)"),
            "the Extensions submenu should be created even when no extension-registered menu items exist",
        );
    }

    #[test]
    fn non_macos_file_menu_exposes_exit() {
        let src = include_str!("app_menu.rs");
        assert!(
            src.contains("PredefinedMenuItem::quit(app, Some(\"Exit\"))"),
            "Linux/Windows should expose File → Exit; macOS keeps Quit in the app menu",
        );
    }
}
