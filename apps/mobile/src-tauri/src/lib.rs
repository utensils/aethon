//! Aethon iOS companion shell.
//!
//! Intentionally thin: it hosts the reused web UI (built by
//! `vite.mobile.config.ts` into `dist-mobile`), wires the native plugins
//! the mobile UI uses (notifications, opener), and exposes the
//! `gateway_*` commands that own the pinned WebSocket to a paired
//! desktop. All product logic lives in the web layer and, ultimately,
//! on the desktop the app pairs with.

mod discovery;
mod gateway;
mod pair;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());
    // Camera scanner exists only on the mobile OSes (matches the
    // target-gated Cargo dependency).
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .setup(|app| {
            gateway::register(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gateway::gateway_connect,
            gateway::gateway_send,
            gateway::gateway_close,
            pair::gateway_pair,
            discovery::discovery_scan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running aethon-mobile");
}
