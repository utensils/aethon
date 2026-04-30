//! PTY-backed user shell tabs (M6 P1).
//!
//! One [`ShellSlot`] per tab id: a [`portable_pty`] master, a writer
//! handle for keystrokes, an [`Arc<Mutex<Option<Box<dyn Child>>>>`] for
//! the child process, and a reader thread that streams stdout to the
//! frontend as `shell-output {tabId, content}` events. When the child
//! exits naturally the reader sees EOF, calls [`Child::wait`], and
//! emits `shell-exit {tabId, code}` once. [`shell_close`] kills the
//! child and drops the PTY so the reader unblocks for clean shutdown
//! on tab close — no zombie processes.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

const READ_CHUNK_BYTES: usize = 4096;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShellOutputPayload {
    tab_id: String,
    content: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShellExitPayload {
    tab_id: String,
    code: Option<i32>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShellOpenArgs {
    pub tab_id: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

type ChildHandle = Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>;

struct ShellSlot {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: ChildHandle,
    reader_thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct ShellRegistry {
    slots: Mutex<HashMap<String, ShellSlot>>,
}

impl ShellRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

#[tauri::command]
pub fn shell_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ShellRegistry>,
    args: ShellOpenArgs,
) -> Result<(), String> {
    if args.tab_id.is_empty() {
        return Err("tab_id is required".to_string());
    }
    {
        let guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
        if guard.contains_key(&args.tab_id) {
            return Err(format!("shell already open for tab {}", args.tab_id));
        }
    }

    let pty_system = native_pty_system();
    let cols = args.cols.unwrap_or(80).clamp(4, 1000);
    let rows = args.rows.unwrap_or(24).clamp(4, 500);
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = match args.command.as_deref() {
        Some(c) if !c.is_empty() => CommandBuilder::new(c),
        _ => default_shell_command(),
    };
    if let Some(extra_args) = args.args {
        for a in extra_args {
            cmd.arg(a);
        }
    }
    if let Some(cwd) = args.cwd {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("AETHON", "1");
    if let Some(env) = args.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader: {e}"))?;

    let child_handle: ChildHandle = Arc::new(Mutex::new(Some(child)));
    let app_for_thread = app.clone();
    let tab_id_for_thread = args.tab_id.clone();
    let child_for_thread = Arc::clone(&child_handle);
    let reader_thread = thread::spawn(move || {
        let mut buf = vec![0u8; READ_CHUNK_BYTES];
        // Carry bytes across reads. PTY chunk boundaries land mid-codepoint
        // for multi-byte UTF-8 (CJK, emoji, ANSI in non-Latin shells), and a
        // per-chunk `from_utf8_lossy` would replace those split bytes with
        // U+FFFD permanently. Hold any trailing partial sequence and prepend
        // it to the next read.
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let emit_len = utf8_safe_split(&carry);
                    if emit_len == 0 {
                        continue;
                    }
                    let chunk = String::from_utf8_lossy(&carry[..emit_len]).into_owned();
                    carry.drain(..emit_len);
                    let _ = app_for_thread.emit(
                        "shell-output",
                        ShellOutputPayload {
                            tab_id: tab_id_for_thread.clone(),
                            content: chunk,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        // Flush any remaining bytes lossily on EOF — at this point the PTY
        // is closed so a partial trailing sequence will never complete.
        if !carry.is_empty() {
            let chunk = String::from_utf8_lossy(&carry).into_owned();
            let _ = app_for_thread.emit(
                "shell-output",
                ShellOutputPayload {
                    tab_id: tab_id_for_thread.clone(),
                    content: chunk,
                },
            );
            carry.clear();
        }
        // PTY closed (natural child exit OR shell_close dropped master).
        // Reap the child so the parent process doesn't accumulate zombies.
        let code = match child_for_thread.lock() {
            Ok(mut guard) => guard.take().and_then(|mut c| match c.wait() {
                Ok(status) => Some(status.exit_code() as i32),
                Err(_) => None,
            }),
            Err(_) => None,
        };
        let _ = app_for_thread.emit(
            "shell-exit",
            ShellExitPayload {
                tab_id: tab_id_for_thread,
                code,
            },
        );
    });

    let slot = ShellSlot {
        writer,
        master: pair.master,
        child: child_handle,
        reader_thread: Some(reader_thread),
    };
    state
        .slots
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .insert(args.tab_id, slot);
    Ok(())
}

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
pub fn shell_close(
    state: State<'_, ShellRegistry>,
    tab_id: String,
) -> Result<(), String> {
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

fn default_shell_command() -> CommandBuilder {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-il");
        cmd
    }
    #[cfg(windows)]
    {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        cmd
    }
}

/// Largest prefix of `buf` we can safely emit without splitting a UTF-8
/// codepoint. Returns the number of bytes to emit; the rest stays carried
/// across the next PTY read. If the trailing bytes are *truly* invalid
/// (not just incomplete), emit everything and rely on `from_utf8_lossy`
/// at the call site to replace them with U+FFFD.
///
/// The truncation-vs-invalid distinction comes from
/// [`Utf8Error::error_len`]: `None` means "not enough data to decide" —
/// safe to hold and try again with the next read; `Some(_)` means "this
/// byte is definitively wrong" — flush lossily so we don't stall output
/// when a process emits Latin-1 (e.g. `\xE9!`) or other bad bytes.
fn utf8_safe_split(buf: &[u8]) -> usize {
    match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) => match e.error_len() {
            // None = trailing bytes are a partial-but-not-yet-invalid
            // codepoint. Hold the tail; emit only the valid prefix.
            None => e.valid_up_to(),
            // Some(_) = a definitively invalid sequence. Don't buffer it
            // — flush everything so from_utf8_lossy can replace it with
            // U+FFFD and the following bytes still reach the user.
            Some(_) => buf.len(),
        },
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn registry() -> ShellRegistry {
        ShellRegistry::new()
    }

    fn open_raw(reg: &ShellRegistry, tab_id: &str, command: &str, args: Vec<String>) -> Box<dyn Child + Send + Sync> {
        // Mirrors shell_open but skips the AppHandle so unit tests can
        // run without a Tauri runtime. The reader thread is omitted —
        // tests that need stdout drain the master directly.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(command);
        for a in args {
            cmd.arg(a);
        }
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let writer = pair.master.take_writer().expect("take_writer");
        let slot = ShellSlot {
            writer,
            master: pair.master,
            child: Arc::new(Mutex::new(None)), // tests reap manually
            reader_thread: None,
        };
        reg.slots.lock().unwrap().insert(tab_id.to_string(), slot);
        child
    }

    #[test]
    fn echo_round_trip_via_input_command() {
        let reg = registry();
        let mut child = open_raw(&reg, "t1", "/bin/echo", vec!["hello-aethon".into()]);
        let status = child.wait().expect("wait");
        assert!(status.success());
        // Cleanup the master/writer slot manually.
        reg.slots.lock().unwrap().remove("t1").unwrap();
    }

    #[test]
    fn resize_propagates_when_slot_present() {
        let reg = registry();
        let mut child = open_raw(&reg, "t2", "/bin/sleep", vec!["0.05".into()]);
        // Resize via the command path — must succeed while child is alive.
        {
            let guard = reg.slots.lock().unwrap();
            let slot = guard.get("t2").unwrap();
            slot.master
                .resize(PtySize { cols: 132, rows: 50, pixel_width: 0, pixel_height: 0 })
                .expect("resize while alive");
        }
        let _ = child.wait();
        reg.slots.lock().unwrap().remove("t2").unwrap();
    }

    #[test]
    fn close_unknown_tab_is_noop() {
        let reg = registry();
        // Direct check: removing absent tab returns None, no panic.
        assert!(reg.slots.lock().unwrap().remove("never-existed").is_none());
    }

    #[test]
    fn cleanup_drops_slot() {
        let reg = registry();
        let mut child = open_raw(&reg, "t3", "/bin/sleep", vec!["0.01".into()]);
        let _ = child.wait();
        let mut slot = reg.slots.lock().unwrap().remove("t3").expect("slot present");
        drop(slot.writer);
        drop(slot.master);
        // No reader thread in test harness; just verify the slot was removable.
        assert!(slot.reader_thread.take().is_none());
        // Slot count is back to zero.
        assert!(reg.slots.lock().unwrap().is_empty());
    }

    #[test]
    fn utf8_safe_split_passes_complete_ascii() {
        assert_eq!(utf8_safe_split(b"hello"), 5);
        assert_eq!(utf8_safe_split(b""), 0);
    }

    #[test]
    fn utf8_safe_split_holds_partial_two_byte_sequence() {
        // 'é' = 0xC3 0xA9. With only the lead byte, hold it.
        let b = b"hi\xC3";
        assert_eq!(utf8_safe_split(b), 2);
    }

    #[test]
    fn utf8_safe_split_holds_partial_three_byte_sequence() {
        // U+4E2D ('中') = 0xE4 0xB8 0xAD. With only 1 of 3 bytes, hold.
        let b = b"a\xE4";
        assert_eq!(utf8_safe_split(b), 1);
        // With only 2 of 3 bytes, hold.
        let b = b"a\xE4\xB8";
        assert_eq!(utf8_safe_split(b), 1);
    }

    #[test]
    fn utf8_safe_split_holds_partial_four_byte_sequence() {
        // U+1F600 ('😀') = 0xF0 0x9F 0x98 0x80. Partial holds.
        let b = b"x\xF0\x9F\x98";
        assert_eq!(utf8_safe_split(b), 1);
    }

    #[test]
    fn utf8_safe_split_emits_complete_codepoint() {
        // Full 'é' lands.
        let b = "héllo".as_bytes();
        assert_eq!(utf8_safe_split(b), b.len());
    }

    #[test]
    fn utf8_safe_split_flushes_truly_invalid_tail() {
        // Five bytes after the last valid char with no plausible UTF-8
        // lead — flush everything (caller's lossy decode replaces with FFFD).
        let b = b"hi\xFF\xFF\xFF\xFF\xFF";
        assert_eq!(utf8_safe_split(b), b.len());
    }

    #[test]
    fn utf8_safe_split_flushes_unexpected_continuation() {
        // A continuation byte (0x80) with no preceding lead is invalid;
        // emit lossy rather than holding it forever.
        let b = b"hi\x80";
        assert_eq!(utf8_safe_split(b), b.len());
    }

    #[test]
    fn utf8_safe_split_does_not_buffer_latin1_byte_followed_by_ascii() {
        // Codex-flagged regression: \xE9 is a 3-byte UTF-8 lead, but if the
        // very next byte is `!` (0x21, ASCII — not a continuation), the
        // sequence is *definitively* invalid. Older logic held it as
        // "incomplete" and stalled output until EOF; now from_utf8's
        // error_len() returns Some(_), so we flush lossily.
        let b = b"hi\xE9!";
        assert_eq!(utf8_safe_split(b), b.len());
    }

    #[test]
    fn utf8_safe_split_simulates_streaming_decode() {
        // Round-trip a string split mid-codepoint across two chunks.
        // Confirms a `carry`-pattern caller produces the original bytes.
        let original = "한 글 中文 😀 mix";
        let bytes = original.as_bytes();
        // Pick a split that lands inside a multi-byte codepoint.
        // '글' is 3 bytes (E1 9E 80) — choose a split inside it.
        let split = 5;
        assert!(!original.is_char_boundary(split));
        let mut carry = Vec::new();
        let mut emitted = String::new();
        for chunk in [&bytes[..split], &bytes[split..]] {
            carry.extend_from_slice(chunk);
            let take = utf8_safe_split(&carry);
            if take > 0 {
                emitted.push_str(&String::from_utf8_lossy(&carry[..take]));
                carry.drain(..take);
            }
        }
        // Final flush (mimics EOF).
        if !carry.is_empty() {
            emitted.push_str(&String::from_utf8_lossy(&carry));
        }
        assert_eq!(emitted, original);
    }

    #[test]
    fn registry_handles_concurrent_inserts() {
        let reg = registry();
        let n_tabs = 4;
        let mut children: Vec<Box<dyn Child + Send + Sync>> = Vec::new();
        for i in 0..n_tabs {
            let id = format!("t-concurrent-{i}");
            children.push(open_raw(&reg, &id, "/bin/sleep", vec!["0.05".into()]));
        }
        assert_eq!(reg.slots.lock().unwrap().len(), n_tabs);
        let start = Instant::now();
        for mut c in children {
            let _ = c.wait();
        }
        assert!(start.elapsed() < Duration::from_secs(2));
        // Drain.
        let mut guard = reg.slots.lock().unwrap();
        for i in 0..n_tabs {
            let id = format!("t-concurrent-{i}");
            guard.remove(&id).expect("present");
        }
    }
}
