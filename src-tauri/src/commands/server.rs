//! Frontend control surface for the built-in HTTP + mDNS server.
//!
//! The browser (peer discovery) always runs and isn't toggleable here —
//! discovery is read-only and safe. These commands cover the local
//! advertiser + HTTP listener, which the user can stop without losing
//! peer visibility.

use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::server::ServerState;

#[derive(Debug, serde::Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub port: Option<u16>,
}

#[tauri::command]
pub async fn server_status(state: State<'_, Arc<ServerState>>) -> Result<ServerStatus, String> {
    let running = state.is_running().await;
    let port = state.port().await;
    Ok(ServerStatus { running, port })
}

#[tauri::command]
pub async fn server_start(
    app: AppHandle,
    state: State<'_, Arc<ServerState>>,
) -> Result<u16, String> {
    // Explicit user action always advertises, regardless of the
    // `[server] enabled` boot gate.
    crate::server::start(&app, state.inner(), true).await
}

#[tauri::command]
pub async fn server_stop(state: State<'_, Arc<ServerState>>) -> Result<(), String> {
    state.stop().await;
    Ok(())
}
