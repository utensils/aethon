//! User-facing PTY control: forward keystrokes, propagate terminal
//! geometry, and tear down the slot. Distinct from
//! [`super::sharing`], which carries the *agent's* mode-gated write
//! path; these commands are the local user's xterm.js keystrokes and
//! always proceed regardless of `ShareMode`.

use std::io::Write;

use portable_pty::PtySize;
use tauri::State;

use super::registry::ShellRegistry;

#[tauri::command]
pub fn shell_input(
    state: State<'_, ShellRegistry>,
    tab_id: String,
    data: String,
) -> Result<(), String> {
    let mut guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
    let slot = guard
        .get_mut(&tab_id)
        .ok_or_else(|| format!("no shell for tab {tab_id}"))?;
    slot.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    slot.writer.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn shell_resize(
    state: State<'_, ShellRegistry>,
    tab_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let cols = cols.clamp(4, 1000);
    let rows = rows.clamp(4, 500);
    let guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
    let slot = guard
        .get(&tab_id)
        .ok_or_else(|| format!("no shell for tab {tab_id}"))?;
    slot.master
        .resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn shell_close(state: State<'_, ShellRegistry>, tab_id: String) -> Result<(), String> {
    let slot = {
        let mut guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
        guard.remove(&tab_id)
    };
    let Some(mut slot) = slot else {
        // Idempotent: closing an already-closed tab is fine.
        return Ok(());
    };
    if let Ok(mut child_guard) = slot.child.lock()
        && let Some(mut child) = child_guard.take()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
    // Dropping master + writer closes the PTY so the reader thread
    // unblocks. Order matters — drop writer first to avoid a deadlock
    // when the reader holds it indirectly.
    drop(slot.writer);
    drop(slot.master);
    if let Some(handle) = slot.reader_thread.take() {
        let _ = handle.join();
    }
    Ok(())
}
