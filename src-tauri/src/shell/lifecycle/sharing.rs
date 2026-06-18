//! Share-mode + scrollback API (M6 P2).
//!
//! Two distinct surfaces share the same `ShareMode`-aware plumbing.
//! Keeping them in one module lets `ShareState`-touching code stay
//! colocated; the security boundary lives in *who* invokes each one:
//!
//! **User-gesture-driven** — invoked from the share-mode badge in
//! the UI. Deliberately **not** reachable through the agent bridge
//! (`aethon.shells.*` proxies only the three commands listed below):
//!
//! - [`shell_set_share_mode`] — updates [`ShareState`][1] atomically;
//!   on `Private → Shareable` transitions, pins the privacy floor at
//!   the live scrollback cursor. The agent cannot escalate its own
//!   access because this entry point is not bridged.
//!
//! **Agent-facing — bridged as `aethon.shells.{list,read,write}`.**
//! All three respect the live mode gate set by the user above:
//!
//! - [`shell_list_shareable`] — metadata for tabs whose mode is not
//!   private. Hidden tabs stay invisible to the agent.
//! - [`shell_read_scrollback`] — returns recent bytes ≥ floor.
//!   Refuses if the mode is private.
//! - [`shell_write`] — mode-gated agent keystroke injection. Distinct
//!   from [`super::io::shell_input`] (the user's own ungated path).
//!
//! [1]: crate::shell::sharemode::ShareState

use std::io::Write;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::registry::ShellRegistry;
use crate::shell::sharemode::ShareMode;

const READ_DEFAULT_MAX: usize = 8 * 1024;
const READ_HARD_CAP: usize = 64 * 1024;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShareableShell {
    pub tab_id: String,
    pub cwd: String,
    pub command: String,
    pub share_mode: ShareMode,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackSnapshot {
    pub content: String,
    /// Cursor at the end of `content`. Pass back as `since_total` to
    /// resume the stream without re-reading bytes already seen.
    pub total_appended: u64,
    pub share_floor: u64,
    pub share_mode: ShareMode,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShellReadArgs {
    pub tab_id: String,
    /// Cursor returned by the previous read. Pass `None` to start from
    /// the privacy floor (most-recent-first behavior bounded by `max_bytes`).
    #[serde(default)]
    pub since_total: Option<u64>,
    /// Cap on returned content size. Defaults to 8 KiB. Hard cap 64 KiB
    /// so a runaway agent loop can't pull a megabyte at a time.
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

#[tauri::command]
pub fn shell_set_share_mode(
    state: State<'_, ShellRegistry>,
    tab_id: String,
    mode: ShareMode,
) -> Result<ShareMode, String> {
    let guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
    let slot = guard
        .get(&tab_id)
        .ok_or_else(|| format!("no shell for tab {tab_id}"))?;
    let total = slot
        .scrollback
        .lock()
        .map_err(|e| format!("scrollback lock: {e}"))?
        .total_appended();
    let mut share = slot.share.lock().map_err(|e| format!("share lock: {e}"))?;
    share.transition(mode, total);
    Ok(share.mode)
}

#[tauri::command]
pub fn shell_read_scrollback(
    state: State<'_, ShellRegistry>,
    args: ShellReadArgs,
) -> Result<ScrollbackSnapshot, String> {
    let guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
    let slot = guard
        .get(&args.tab_id)
        .ok_or_else(|| format!("no shell for tab {}", args.tab_id))?;
    let share = {
        let s = slot.share.lock().map_err(|e| format!("share lock: {e}"))?;
        (s.mode, s.floor)
    };
    let (mode, floor) = share;
    if !mode.is_shareable() {
        return Err("share mode is private".to_string());
    }
    let max_bytes = args
        .max_bytes
        .unwrap_or(READ_DEFAULT_MAX)
        .min(READ_HARD_CAP);
    let mut sb = slot
        .scrollback
        .lock()
        .map_err(|e| format!("scrollback lock: {e}"))?;
    // Cold-start "show me the latest" when no cursor: rewind from the
    // live total by `max_bytes`, clamped to the privacy floor so we
    // never reach behind it. Subsequent calls pass back the returned
    // `total_appended` so paging walks forward.
    let cursor = match args.since_total {
        Some(c) => c.max(floor),
        None => sb
            .total_appended()
            .saturating_sub(max_bytes as u64)
            .max(floor),
    };
    let (raw, slice_total) = sb.read_from(cursor, max_bytes);
    let content = String::from_utf8_lossy(&raw).into_owned();
    Ok(ScrollbackSnapshot {
        content,
        total_appended: slice_total + raw.len() as u64,
        share_floor: floor,
        share_mode: mode,
    })
}

/// Agent-driven keystroke injection (M6 P2.2). Distinct from
/// [`super::io::shell_input`] (which is the user's own keyboard path,
/// ungated) because the agent's writes pass through a `ShareMode` gate:
/// only `ReadWrite` and `ReadWriteTrusted` are allowed. The frontend
/// layers per-write user confirmation on top of `ReadWrite`; this Rust
/// gate is the underlying defense-in-depth so a frontend bug can't
/// invoke this for a `Read` or `Private` tab.
#[tauri::command]
pub fn shell_write(
    state: State<'_, ShellRegistry>,
    tab_id: String,
    data: String,
) -> Result<(), String> {
    write_keystrokes(&state, &tab_id, data.as_bytes())
}

/// The actual mode-gated write. Split out from the Tauri command so
/// cargo tests can exercise it without a Tauri runtime.
fn write_keystrokes(state: &ShellRegistry, tab_id: &str, data: &[u8]) -> Result<(), String> {
    let mut guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
    let slot = guard
        .get_mut(tab_id)
        .ok_or_else(|| format!("no shell for tab {tab_id}"))?;
    let mode = slot
        .share
        .lock()
        .map_err(|e| format!("share lock: {e}"))?
        .mode;
    if !mode.allows_write() {
        return Err(format!(
            "share mode does not allow agent writes (current: {mode:?})"
        ));
    }
    slot.writer
        .write_all(data)
        .map_err(|e| format!("write: {e}"))?;
    slot.writer.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn shell_list_shareable(
    state: State<'_, ShellRegistry>,
) -> Result<Vec<ShareableShell>, String> {
    let guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
    let mut out = Vec::new();
    for (tab_id, slot) in guard.iter() {
        let mode = slot
            .share
            .lock()
            .map_err(|e| format!("share lock: {e}"))?
            .mode;
        if !mode.is_shareable() {
            continue;
        }
        out.push(ShareableShell {
            tab_id: tab_id.clone(),
            cwd: slot.cwd.clone(),
            command: slot.command.clone(),
            share_mode: mode,
        });
    }
    // Stable order — sort by tab id so the agent gets a deterministic
    // listing across calls (helpful for tests + replay debugging).
    out.sort_by(|a, b| a.tab_id.cmp(&b.tab_id));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::super::registry::ShellRegistry;
    use super::super::registry::test_support::{force_mode, open_raw};
    use super::write_keystrokes;
    use crate::shell::sharemode::ShareMode;

    fn registry() -> ShellRegistry {
        ShellRegistry::new()
    }

    #[test]
    fn write_keystrokes_rejects_private() {
        let reg = registry();
        let mut child = open_raw(&reg, "wp", "sleep", vec!["0.05".into()]);
        let r = write_keystrokes(&reg, "wp", b"hi");
        assert!(r.is_err());
        assert!(
            r.as_ref().unwrap_err().contains("does not allow"),
            "expected gating error, got: {:?}",
            r.err()
        );
        let _ = child.wait();
        reg.slots.lock().unwrap().remove("wp").unwrap();
    }

    #[test]
    fn write_keystrokes_rejects_read_only() {
        let reg = registry();
        let mut child = open_raw(&reg, "wr", "sleep", vec!["0.05".into()]);
        force_mode(&reg, "wr", ShareMode::Read);
        let r = write_keystrokes(&reg, "wr", b"hi");
        assert!(r.is_err());
        let _ = child.wait();
        reg.slots.lock().unwrap().remove("wr").unwrap();
    }

    #[test]
    fn write_keystrokes_succeeds_for_read_write() {
        let reg = registry();
        let mut child = open_raw(&reg, "wrw", "sleep", vec!["0.05".into()]);
        force_mode(&reg, "wrw", ShareMode::ReadWrite);
        // The PTY is already alive — write a benign byte.
        let r = write_keystrokes(&reg, "wrw", b"\x03");
        assert!(r.is_ok(), "{:?}", r.err());
        let _ = child.wait();
        reg.slots.lock().unwrap().remove("wrw").unwrap();
    }

    #[test]
    fn write_keystrokes_succeeds_for_read_write_trusted() {
        let reg = registry();
        let mut child = open_raw(&reg, "wrwt", "sleep", vec!["0.05".into()]);
        force_mode(&reg, "wrwt", ShareMode::ReadWriteTrusted);
        let r = write_keystrokes(&reg, "wrwt", b"\x03");
        assert!(r.is_ok(), "{:?}", r.err());
        let _ = child.wait();
        reg.slots.lock().unwrap().remove("wrwt").unwrap();
    }

    #[test]
    fn write_keystrokes_unknown_tab_is_error() {
        let reg = registry();
        let r = write_keystrokes(&reg, "nope", b"hi");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("no shell for tab"));
    }
}
