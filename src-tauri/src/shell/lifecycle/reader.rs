//! PTY reader thread. The function `spawn_reader_thread` owns the
//! detached worker that drains the master side of a tab's PTY, splits
//! the stream on UTF-8 codepoint boundaries, captures OSC 0/1/2 title
//! sequences, appends raw bytes to the per-tab scrollback ring, and
//! emits Tauri `shell-output` / `shell-title` events. On EOF (the
//! child exited *or* `shell_close` dropped the master) it flushes the
//! tail, reaps the child, and emits a single `shell-exit`.

use std::io::Read;
use std::thread::{self, JoinHandle};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use super::registry::{ChildHandle, ScrollbackHandle};

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

/// Title update payload — emitted when a shell's output stream contains
/// an OSC 0/1/2 title-set sequence. The frontend updates the sub-tab
/// label (`<title>`) in place. Cosmetic — the underlying tab id /
/// command / cwd don't change.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShellTitlePayload {
    tab_id: String,
    title: String,
}

/// Spawn the per-tab PTY reader thread. Returns the `JoinHandle` so
/// `shell_close` can join after dropping the master (the reader
/// unblocks on EOF).
pub(super) fn spawn_reader_thread<R: Runtime>(
    mut reader: Box<dyn Read + Send>,
    scrollback: ScrollbackHandle,
    child: ChildHandle,
    app: AppHandle<R>,
    tab_id: String,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = vec![0u8; READ_CHUNK_BYTES];
        // Carry bytes across reads. PTY chunk boundaries land mid-codepoint
        // for multi-byte UTF-8 (CJK, emoji, ANSI in non-Latin shells), and a
        // per-chunk `from_utf8_lossy` would replace those split bytes with
        // U+FFFD permanently. Hold any trailing partial sequence and prepend
        // it to the next read.
        let mut carry: Vec<u8> = Vec::new();
        // OSC title-set buffer. Many shells (zsh, bash with PROMPT_COMMAND,
        // vim, ssh, htop) emit `\x1b]0;<title>\x07` or `\x1b]2;<title>\x07`
        // to update their host terminal's tab title. Capturing it here
        // gives us "vim · README.md" / "user@host" / "htop" in the sub-tab
        // label without needing per-platform foreground-process detection.
        let mut last_title: Option<String> = None;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let emit_len = utf8_safe_split(&carry);
                    if emit_len == 0 {
                        continue;
                    }
                    let raw = carry.drain(..emit_len).collect::<Vec<u8>>();
                    // Append raw bytes (pre-lossy-decode) to the scrollback
                    // ring so cursor math stays stable in *byte* units —
                    // matches what the bridge will offer to the agent.
                    if let Ok(mut sb) = scrollback.lock() {
                        sb.append(&raw);
                    }
                    // Look for OSC title-set sequences in the raw bytes
                    // (cheaper than re-scanning the lossily-decoded chunk
                    // — the sequences are 7-bit ASCII so byte-level scan
                    // is correct). Emit a `shell-title` event when the
                    // captured title changes.
                    if let Some(title) = parse_osc_title(&raw)
                        && last_title.as_deref() != Some(title.as_str())
                    {
                        last_title = Some(title.clone());
                        let _ = app.emit(
                            "shell-title",
                            ShellTitlePayload {
                                tab_id: tab_id.clone(),
                                title,
                            },
                        );
                    }
                    let chunk = String::from_utf8_lossy(&raw).into_owned();
                    let _ = app.emit(
                        "shell-output",
                        ShellOutputPayload {
                            tab_id: tab_id.clone(),
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
            if let Ok(mut sb) = scrollback.lock() {
                sb.append(&carry);
            }
            let chunk = String::from_utf8_lossy(&carry).into_owned();
            let _ = app.emit(
                "shell-output",
                ShellOutputPayload {
                    tab_id: tab_id.clone(),
                    content: chunk,
                },
            );
            carry.clear();
        }
        // PTY closed (natural child exit OR shell_close dropped master).
        // Reap the child so the parent process doesn't accumulate zombies.
        let code = match child.lock() {
            Ok(mut guard) => guard.take().and_then(|mut c| match c.wait() {
                Ok(status) => Some(status.exit_code() as i32),
                Err(_) => None,
            }),
            Err(_) => None,
        };
        let _ = app.emit("shell-exit", ShellExitPayload { tab_id, code });
    })
}

/// Scan a chunk of raw PTY bytes for the *last* OSC title-set sequence
/// it contains. Returns `Some(title)` when one is found, `None`
/// otherwise. Only OSC 0 ("set both icon name + title"), 1 ("icon name"),
/// and 2 ("window title") are recognised — other OSC codes (palette,
/// hyperlinks, working directory) are ignored. Both ST terminators are
/// supported: BEL (`0x07`) and ESC `\` (`0x1b 0x5c`). Returns the
/// *last* title in the chunk so a shell that emits a snapshot of
/// "command · cwd" right before each prompt wins over the transient
/// updates a child process may have flashed during execution.
fn parse_osc_title(bytes: &[u8]) -> Option<String> {
    let mut i = 0;
    let mut last: Option<String> = None;
    while i + 3 < bytes.len() {
        // Look for OSC introducer `\x1b]`.
        if bytes[i] == 0x1b && bytes[i + 1] == b']' {
            let osc_start = i + 2;
            // Match the leading code: 0;, 1;, or 2;. Anything else, skip.
            let (code_len, valid) = match bytes.get(osc_start..osc_start + 2) {
                Some([b'0', b';']) | Some([b'1', b';']) | Some([b'2', b';']) => (2, true),
                _ => (0, false),
            };
            if !valid {
                i += 1;
                continue;
            }
            let body_start = osc_start + code_len;
            // Find ST: BEL or ESC \ . Bound the search so a malformed
            // sequence can't make us scan to EOF — title-set payloads
            // are short by convention.
            let max_scan = (body_start + 4096).min(bytes.len());
            let mut term_idx: Option<(usize, usize)> = None; // (end_of_title, total_consumed)
            let mut j = body_start;
            while j < max_scan {
                if bytes[j] == 0x07 {
                    term_idx = Some((j, j + 1));
                    break;
                }
                if bytes[j] == 0x1b && bytes.get(j + 1) == Some(&b'\\') {
                    term_idx = Some((j, j + 2));
                    break;
                }
                j += 1;
            }
            if let Some((title_end, advance_to)) = term_idx {
                if let Ok(title) = std::str::from_utf8(&bytes[body_start..title_end]) {
                    let trimmed = title.trim().to_string();
                    if !trimmed.is_empty() {
                        last = Some(trimmed);
                    }
                }
                i = advance_to;
                continue;
            }
            // No terminator — bail to avoid scanning forever on partial
            // sequences. The next chunk's carry will pick up the rest.
            break;
        }
        i += 1;
    }
    last
}

/// Largest prefix of `buf` we can safely emit without splitting a UTF-8
/// codepoint. Returns the number of bytes to emit; the rest stays carried
/// across the next PTY read. If the trailing bytes are *truly* invalid
/// (not just incomplete), emit everything and rely on `from_utf8_lossy`
/// at the call site to replace them with U+FFFD.
///
/// The truncation-vs-invalid distinction comes from
/// [`std::str::Utf8Error::error_len`]: `None` means "not enough data to
/// decide" — safe to hold and try again with the next read; `Some(_)`
/// means "this byte is definitively wrong" — flush lossily so we don't
/// stall output when a process emits Latin-1 (e.g. `\xE9!`) or other
/// bad bytes.
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
    use super::{parse_osc_title, utf8_safe_split};

    // ── parse_osc_title ──────────────────────────────────────────────────
    #[test]
    fn parse_osc_title_recognises_osc_0_with_bel() {
        let bytes = b"\x1b]0;vim README.md\x07rest";
        assert_eq!(parse_osc_title(bytes).as_deref(), Some("vim README.md"));
    }

    #[test]
    fn parse_osc_title_recognises_osc_2_with_st() {
        let bytes = b"\x1b]2;user@host\x1b\\$ ";
        assert_eq!(parse_osc_title(bytes).as_deref(), Some("user@host"));
    }

    #[test]
    fn parse_osc_title_returns_last_match() {
        // Multiple titles in one chunk — the most recent wins so the user's
        // tab label tracks the freshest state.
        let bytes = b"\x1b]0;old\x07stuff\x1b]2;new\x07more";
        assert_eq!(parse_osc_title(bytes).as_deref(), Some("new"));
    }

    #[test]
    fn parse_osc_title_skips_non_title_oscs() {
        // OSC 4 (palette) and OSC 8 (hyperlinks) are not titles.
        let bytes = b"\x1b]4;1;rgb:ff/00/00\x07";
        assert_eq!(parse_osc_title(bytes), None);
        let bytes = b"\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
        assert_eq!(parse_osc_title(bytes), None);
    }

    #[test]
    fn parse_osc_title_handles_empty_title() {
        // Empty title (`\x1b]0;\x07`) shouldn't surface as a label.
        let bytes = b"\x1b]0;\x07";
        assert_eq!(parse_osc_title(bytes), None);
    }

    #[test]
    fn parse_osc_title_returns_none_when_unterminated() {
        // No BEL / ST → don't return a partial title; the next chunk will
        // carry the terminator.
        let bytes = b"\x1b]0;partial title with no terminator and lots of text";
        assert_eq!(parse_osc_title(bytes), None);
    }

    #[test]
    fn parse_osc_title_ignores_plain_text() {
        let bytes = b"$ ls\r\nfoo  bar  baz\r\n";
        assert_eq!(parse_osc_title(bytes), None);
    }

    // ── utf8_safe_split ──────────────────────────────────────────────────
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
}
