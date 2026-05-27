//! Boot probation IPC commands. Frontend reports `boot_stage("react_mounted")`
//! and `boot_stage("initial_data_loading")` as it makes progress through
//! startup, then calls `boot_ok` after first useful render so the post-update
//! rollback timer is cancelled and the sentinel cleared.
//!
//! See [`crate::boot_probation`] for the full rollback flow and the
//! sentinel/report file layout under `<aethon_dir>/`.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::boot_probation::{self, BootStage};
use crate::updater_state::UpdaterState;

#[tauri::command]
pub fn boot_stage(app: AppHandle, stage: BootStage, detail: Option<String>) -> Result<(), String> {
    let data_dir = aethon_data_dir(&app)?;
    if boot_probation::record_boot_stage(&data_dir, stage.clone(), detail)? {
        tracing::debug!(target: "aethon::updater", ?stage, "boot probation stage recorded");
    }
    Ok(())
}

#[tauri::command]
pub fn boot_ok(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String> {
    let data_dir = aethon_data_dir(&app)?;
    boot_probation::acknowledge_boot(&data_dir, &state.boot_probation)?;
    tracing::debug!(target: "aethon::updater", "boot probation acknowledged by frontend");
    Ok(())
}

fn aethon_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())
}
