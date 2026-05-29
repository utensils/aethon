//! Main-window controls + updater gating.
//!
//! Fullscreen + DevTools toggles flow through here so the menu
//! accelerator and frontend keybindings always do the same thing. The
//! DevTools toggle is debug-only — the release stub errors so frontend
//! code can show a "devtools not available" toast without crashing.
//!
//! `updater_pubkey_configured` is read from the embedded
//! `tauri.conf.json` at runtime; `updater_available` is the
//! frontend-facing boolean that gates the "Check for Updates" menu.

use tauri::{AppHandle, Manager};

/// True when the updater plugin has a usable pubkey configured.
/// Reads tauri.conf.json (the source of truth at runtime via
/// generate_context!) by parsing the embedded JSON. Returns false on
/// missing-or-empty so dev builds can boot without bogus keys and the
/// frontend can surface a clear "updater not configured" message.
pub fn updater_pubkey_configured() -> bool {
    static CONF: &str = include_str!("../../tauri.conf.json");
    let v: serde_json::Value = match serde_json::from_str(CONF) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let pubkey = v
        .get("plugins")
        .and_then(|p| p.get("updater"))
        .and_then(|u| u.get("pubkey"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    !pubkey.trim().is_empty()
}

/// Tauri command the frontend uses to know whether to show the
/// "Check for Updates" UI as enabled or as a "not configured" hint.
#[tauri::command]
pub fn updater_available() -> bool {
    cfg!(not(any(target_os = "android", target_os = "ios"))) && updater_pubkey_configured()
}

/// Toggle main-window fullscreen. Mac uses `Cmd+Ctrl+F`, others use `F11`;
/// the menu accelerator + frontend keybindings both flow through here so
/// behaviour stays consistent. No-op (returns Ok) when no main window.
#[tauri::command]
pub fn toggle_fullscreen(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let cur = win
        .is_fullscreen()
        .map_err(|e| format!("is_fullscreen: {e}"))?;
    win.set_fullscreen(!cur)
        .map_err(|e| format!("set_fullscreen: {e}"))?;
    Ok(())
}

/// Toggle WebKit DevTools on the main window. Debug builds only — release
/// builds get a stub that errors so frontend code can show a "devtools
/// not available" toast. This matches the security stance of stripping
/// devtools from shipping bundles.
#[cfg(debug_assertions)]
#[tauri::command]
pub fn toggle_devtools(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    if win.is_devtools_open() {
        win.close_devtools();
    } else {
        win.open_devtools();
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
#[tauri::command]
pub fn toggle_devtools(_app: AppHandle) -> Result<(), String> {
    Err("devtools are unavailable in release builds".to_string())
}

#[cfg(test)]
mod tests {
    /// Regression: macOS overlay-titlebar window dragging and
    /// double-click-to-maximize go through `plugin:window|start_dragging`
    /// and `plugin:window|internal_toggle_maximize`. Tauri's ACL rejects
    /// those IPC calls server-side unless the capability set grants them —
    /// and the frontend `.catch` swallows the rejection, so the only symptom
    /// is "the window won't move." Lock the grants in so a capabilities edit
    /// can't silently break dragging again.
    #[test]
    fn default_capability_grants_window_drag_and_maximize() {
        static CAPS: &str = include_str!("../../capabilities/default.json");
        let v: serde_json::Value =
            serde_json::from_str(CAPS).expect("capabilities/default.json parses");
        let perms: Vec<&str> = v
            .get("permissions")
            .and_then(|p| p.as_array())
            .expect("permissions array")
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        assert!(
            perms.contains(&"core:window:allow-start-dragging"),
            "missing core:window:allow-start-dragging — header/sidebar window drag will silently fail",
        );
        assert!(
            perms.contains(&"core:window:allow-internal-toggle-maximize"),
            "missing core:window:allow-internal-toggle-maximize — double-click-to-maximize will silently fail",
        );
    }
}
