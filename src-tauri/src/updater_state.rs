//! Tauri-managed state shared by the auto-updater commands and the
//! boot-probation timer.
//!
//! Aethon's shell deliberately avoids a god `AppState` — each
//! subsystem registers its own `manage()`d type. This struct bundles
//! the two updater-shaped pieces of state that callers reach for
//! together: the most-recent `tauri_plugin_updater::Update` (held
//! between `check_for_updates_with_channel` and
//! `install_pending_update`, because `Update` isn't Serialize so it
//! can't cross IPC) plus the in-memory `BootProbationState` the
//! sentinel timer cancels.
//!
//! `pending_update` is a `tokio::sync::Mutex` so the async install
//! command can hold it across `await`s; the boot-probation handle is
//! an `Arc` so the timer task spawned in `setup()` and the `boot_ok`
//! IPC command both reference the same `AtomicBool` + `Notify`.

use std::sync::Arc;

use crate::boot_probation::BootProbationState;

#[derive(Default)]
pub struct UpdaterState {
    pub pending_update: tokio::sync::Mutex<Option<tauri_plugin_updater::Update>>,
    pub boot_probation: Arc<BootProbationState>,
}

impl UpdaterState {
    pub fn new() -> Self {
        Self::default()
    }
}
