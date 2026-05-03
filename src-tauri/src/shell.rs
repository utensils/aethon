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

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

const READ_CHUNK_BYTES: usize = 4096;

/// Per-tab scrollback ring cap. 1 MiB lands ~10–20k lines of typical
/// terminal output — enough for the agent to skim back through a build
/// or a `git log`, bounded so a runaway process can't OOM us.
const SCROLLBACK_BYTES: usize = 1024 * 1024;

/// Agent ↔ shell sharing model. Default is `Private` — the agent sees
/// nothing of the tab's contents until the user opts in. The four-value
/// shape is intentional: `ReadWrite` is the same as `ReadWriteTrusted`
/// with confirmation gating; merging them would erase the difference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShareMode {
    Private,
    Read,
    ReadWrite,
    ReadWriteTrusted,
}

impl ShareMode {
    pub fn is_shareable(self) -> bool {
        !matches!(self, Self::Private)
    }
    /// Used by the (P2.2) write path to gate `aethon.shells.write` —
    /// kept in P2.1 alongside `is_shareable` so the predicate set lives
    /// in one place.
    #[allow(dead_code)]
    pub fn allows_write(self) -> bool {
        matches!(self, Self::ReadWrite | Self::ReadWriteTrusted)
    }
}

/// Mode + privacy-floor pair. Held under a single mutex so transitions
/// are atomic — flipping mode and bumping the floor must never tear,
/// otherwise an agent read could land between the two writes and
/// observe scrollback from before the user opted in.
#[derive(Debug)]
pub struct ShareState {
    pub mode: ShareMode,
    /// Byte index in [`Scrollback::total_appended`] space below which
    /// reads are not allowed. Set on each transition into a shareable
    /// mode from a non-shareable one. Stays put across shareable→shareable
    /// transitions and across shareable→private→shareable round-trips
    /// (so a user toggling read off then back on doesn't suddenly
    /// re-expose the in-between window).
    pub floor: u64,
}

impl ShareState {
    pub fn new() -> Self {
        Self {
            mode: ShareMode::Private,
            floor: 0,
        }
    }
    /// Apply a mode change relative to the live scrollback cursor.
    /// Bumps `floor` to `total_appended` whenever the new mode is
    /// shareable AND was previously private — that's the moment the
    /// agent first gains visibility, and only content from that point
    /// on is in-bounds. Returns the resulting state.
    pub fn transition(&mut self, next: ShareMode, total_appended: u64) -> &Self {
        let was_private = !self.mode.is_shareable();
        let now_shareable = next.is_shareable();
        if was_private && now_shareable {
            self.floor = total_appended;
        }
        self.mode = next;
        self
    }
}

impl Default for ShareState {
    fn default() -> Self {
        Self::new()
    }
}

/// Capped byte ring with a monotonic write cursor. The ring drops oldest
/// bytes on overflow; `total_appended` keeps growing forever so callers
/// can use it as a stable cursor for incremental reads ("give me bytes
/// since N"). `oldest_total` is the smallest cursor still in the ring —
/// reads with a cursor below that get clamped up to it.
#[derive(Debug)]
pub struct Scrollback {
    bytes: VecDeque<u8>,
    cap: usize,
    total_appended: u64,
}

impl Scrollback {
    pub fn new(cap: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
            total_appended: 0,
        }
    }
    pub fn append(&mut self, chunk: &[u8]) {
        self.bytes.extend(chunk.iter().copied());
        self.total_appended = self.total_appended.saturating_add(chunk.len() as u64);
        // Drop oldest bytes until back under cap. `drain` on VecDeque is
        // O(n) but the cap is fixed so overflow drops are bounded per
        // append — the worst case is the first chunk after the ring
        // reaches cap, after which every subsequent chunk drops a
        // chunk-sized slice.
        if self.bytes.len() > self.cap {
            let drop = self.bytes.len() - self.cap;
            self.bytes.drain(..drop);
        }
    }
    /// Smallest cursor still in the ring. Equal to
    /// `total_appended - bytes.len()`.
    pub fn oldest_total(&self) -> u64 {
        self.total_appended - self.bytes.len() as u64
    }
    pub fn total_appended(&self) -> u64 {
        self.total_appended
    }
    /// Forward-page from `since_total`: returns up to `max_bytes` bytes
    /// starting at that cursor, plus the cursor of the slice's first
    /// byte. Caller advances the cursor as `slice_total + content.len()`.
    /// `since_total` below the live oldest is clamped up.
    ///
    /// Note: this is a *forward* read. To get the most recent N bytes
    /// (cold-start "show me what's on screen"), pass
    /// `since_total = total_appended - N` clamped to the privacy floor —
    /// the call site in [`shell_read_scrollback`] does exactly that.
    /// A previous version always returned the tail of `max_bytes` from
    /// the after-skip window, which made paging skip bytes (codex P2):
    /// `read(since=0, max=4)` on a 12-byte buffer returned the last 4
    /// bytes and reported `total=8`, so the next cursor jumped past
    /// bytes 0..8 forever.
    pub fn read_from(&mut self, since_total: u64, max_bytes: usize) -> (Vec<u8>, u64) {
        let oldest = self.oldest_total();
        let from_total = since_total.max(oldest);
        let skip = (from_total - oldest) as usize;
        if skip >= self.bytes.len() {
            return (Vec::new(), self.total_appended);
        }
        let after_skip = self.bytes.len() - skip;
        let take = after_skip.min(max_bytes);
        let contig = self.bytes.make_contiguous();
        (contig[skip..skip + take].to_vec(), from_total)
    }
}

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

/// Scan a chunk of raw PTY bytes for the *last* OSC title-set sequence
/// it contains. Returns `Some(title)` when one is found, `None`
/// otherwise. Only OSC 0 ("set both icon name + title"), 1 ("icon name"),
/// and 2 ("window title") are recognised — other OSC codes (palette,
/// hyperlinks, working directory) are ignored. Both ST terminators are
/// supported: BEL (`0x07`) and ESC `\` (`0x1b 0x5c`). Returns the
/// *last* title in the chunk so a shell that emits a snapshot of
/// "command · cwd" right before each prompt wins over the transient
/// updates a child process may have flashed during execution.
pub(crate) fn parse_osc_title(bytes: &[u8]) -> Option<String> {
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
    /// Initial share mode. When non-private, the privacy floor pins at
    /// 0 (the reader hasn't appended anything yet), so the user sees
    /// every byte from the very first prompt onward — closes the
    /// codex-flagged "configured default sharing misses login banner"
    /// race that existed when the seed was applied post-open.
    #[serde(default)]
    pub share_mode: Option<ShareMode>,
    /// When false, clear the inherited process env before applying
    /// `TERM`/`COLORTERM`/`AETHON` and the per-tab `env` table. Defaults
    /// to true (inherit). Mirrors `[shell] inherit_env`.
    #[serde(default)]
    pub inherit_env: Option<bool>,
}

type ChildHandle = Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>;
type ScrollbackHandle = Arc<Mutex<Scrollback>>;
type ShareHandle = Arc<Mutex<ShareState>>;

struct ShellSlot {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: ChildHandle,
    reader_thread: Option<JoinHandle<()>>,
    scrollback: ScrollbackHandle,
    share: ShareHandle,
    /// Cosmetic. Carried for the status-line badge + `list_shareable`.
    /// Not authoritative — the agent always re-asks Rust for live state.
    cwd: String,
    command: String,
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
    if let Some(cwd) = args.cwd.as_ref() {
        cmd.cwd(cwd);
    }
    // Hermetic mode: drop the host env before stamping our own
    // baseline. `TERM`/`COLORTERM`/`AETHON` and the explicit per-tab
    // `env` table still get applied below so the shell remains usable.
    if args.inherit_env == Some(false) {
        cmd.env_clear();
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
    let scrollback_handle: ScrollbackHandle =
        Arc::new(Mutex::new(Scrollback::new(SCROLLBACK_BYTES)));
    // Apply the configured initial share mode *before* the reader thread
    // starts streaming output — pinning the floor at total_appended=0
    // means the user sees every byte from the first prompt onward when
    // they configured a non-private default. Applying post-open would
    // race the early banner / shell prompt and pin them below the floor.
    let initial_share_state = match args.share_mode {
        Some(mode) if mode != ShareMode::Private => {
            let mut s = ShareState::new();
            s.transition(mode, 0);
            s
        }
        _ => ShareState::new(),
    };
    let share_handle: ShareHandle = Arc::new(Mutex::new(initial_share_state));
    let app_for_thread = app.clone();
    let tab_id_for_thread = args.tab_id.clone();
    let child_for_thread = Arc::clone(&child_handle);
    let scrollback_for_thread = Arc::clone(&scrollback_handle);
    let reader_thread = thread::spawn(move || {
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
                    if let Ok(mut sb) = scrollback_for_thread.lock() {
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
                        let _ = app_for_thread.emit(
                            "shell-title",
                            ShellTitlePayload {
                                tab_id: tab_id_for_thread.clone(),
                                title,
                            },
                        );
                    }
                    let chunk = String::from_utf8_lossy(&raw).into_owned();
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
            if let Ok(mut sb) = scrollback_for_thread.lock() {
                sb.append(&carry);
            }
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

    let display_cwd = args.cwd.clone().unwrap_or_default();
    let display_command = args.command.clone().unwrap_or_else(default_shell_label);
    let slot = ShellSlot {
        writer,
        master: pair.master,
        child: child_handle,
        reader_thread: Some(reader_thread),
        scrollback: scrollback_handle,
        share: share_handle,
        cwd: display_cwd,
        command: display_command,
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

fn default_shell_command() -> CommandBuilder {
    #[cfg(unix)]
    {
        let mut cmd = CommandBuilder::new(default_shell_label());
        cmd.arg("-il");
        cmd
    }
    #[cfg(windows)]
    {
        let mut cmd = CommandBuilder::new(default_shell_label());
        cmd.arg("-NoLogo");
        cmd
    }
}

fn default_shell_label() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
}

// =============================================================================
// Share-mode + scrollback API (M6 P2)
// =============================================================================
//
// Three Tauri commands exposed to the frontend, which proxies bridge
// requests for `aethon.shells.{list,read}`:
//
//   shell_set_share_mode(tabId, mode)  → updates ShareState atomically;
//                                         on private→shareable transitions,
//                                         pins the privacy floor at the
//                                         live scrollback cursor.
//   shell_read_scrollback(tabId, ...)  → returns recent bytes ≥ floor.
//                                         Refuses if mode is private.
//   shell_list_shareable()              → metadata for tabs whose mode is
//                                         not private. Hidden tabs stay
//                                         invisible to the agent.

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

const READ_DEFAULT_MAX: usize = 8 * 1024;
const READ_HARD_CAP: usize = 64 * 1024;

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
/// [`shell_input`] (which is the user's own keyboard path, ungated)
/// because the agent's writes pass through a `ShareMode` gate: only
/// `ReadWrite` and `ReadWriteTrusted` are allowed. The frontend layers
/// per-write user confirmation on top of `ReadWrite`; this Rust gate is
/// the underlying defense-in-depth so a frontend bug can't invoke this
/// for a `Read` or `Private` tab.
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

    fn registry() -> ShellRegistry {
        ShellRegistry::new()
    }

    fn open_raw(
        reg: &ShellRegistry,
        tab_id: &str,
        command: &str,
        args: Vec<String>,
    ) -> Box<dyn Child + Send + Sync> {
        // Mirrors shell_open but skips the AppHandle so unit tests can
        // run without a Tauri runtime. The reader thread is omitted —
        // tests that need stdout drain the master directly.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
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
            scrollback: Arc::new(Mutex::new(Scrollback::new(SCROLLBACK_BYTES))),
            share: Arc::new(Mutex::new(ShareState::new())),
            cwd: String::new(),
            command: command.to_string(),
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
                .resize(PtySize {
                    cols: 132,
                    rows: 50,
                    pixel_width: 0,
                    pixel_height: 0,
                })
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
        let mut slot = reg
            .slots
            .lock()
            .unwrap()
            .remove("t3")
            .expect("slot present");
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

    // ----- ShareMode + ShareState -------------------------------------------

    #[test]
    fn share_mode_classification() {
        assert!(!ShareMode::Private.is_shareable());
        assert!(ShareMode::Read.is_shareable());
        assert!(ShareMode::ReadWrite.is_shareable());
        assert!(ShareMode::ReadWriteTrusted.is_shareable());
        assert!(!ShareMode::Private.allows_write());
        assert!(!ShareMode::Read.allows_write());
        assert!(ShareMode::ReadWrite.allows_write());
        assert!(ShareMode::ReadWriteTrusted.allows_write());
    }

    #[test]
    fn share_state_floor_pins_at_first_shareable_transition() {
        let mut s = ShareState::new();
        assert_eq!(s.floor, 0);
        s.transition(ShareMode::Read, 1024);
        assert_eq!(s.floor, 1024);
        // Shareable → shareable: floor stays put.
        s.transition(ShareMode::ReadWrite, 2048);
        assert_eq!(s.floor, 1024);
        // Shareable → private: floor stays put.
        s.transition(ShareMode::Private, 3072);
        assert_eq!(s.floor, 1024);
        // Private → shareable again: floor advances to *now*. No
        // re-exposure of the in-between window.
        s.transition(ShareMode::Read, 4096);
        assert_eq!(s.floor, 4096);
    }

    #[test]
    fn share_state_round_trip_through_private_does_not_leak_old_window() {
        // Concrete attack scenario: user grants Read at byte 100, runs
        // sensitive output to 500, flips to Private, runs more output to
        // 1000, flips back to Read. The agent must not see the 500–1000
        // window — the floor must advance to 1000.
        let mut s = ShareState::new();
        s.transition(ShareMode::Read, 100);
        assert_eq!(s.floor, 100);
        s.transition(ShareMode::Private, 500);
        s.transition(ShareMode::Read, 1000);
        assert_eq!(s.floor, 1000);
    }

    // ----- Scrollback --------------------------------------------------------

    #[test]
    fn scrollback_append_advances_total() {
        let mut sb = Scrollback::new(1024);
        sb.append(b"hello");
        sb.append(b" world");
        assert_eq!(sb.total_appended(), 11);
        assert_eq!(sb.oldest_total(), 0);
    }

    #[test]
    fn scrollback_drops_oldest_on_overflow() {
        let mut sb = Scrollback::new(8);
        sb.append(b"abcdefgh");
        assert_eq!(sb.total_appended(), 8);
        assert_eq!(sb.oldest_total(), 0);
        sb.append(b"IJ");
        assert_eq!(sb.total_appended(), 10);
        assert_eq!(sb.oldest_total(), 2);
        let (got, slice_total) = sb.read_from(0, 16);
        assert_eq!(got, b"cdefghIJ");
        assert_eq!(slice_total, 2);
    }

    #[test]
    fn scrollback_read_from_clamps_below_oldest() {
        let mut sb = Scrollback::new(4);
        sb.append(b"WXYZ1234"); // oldest=4, total=8
        let (got, slice_total) = sb.read_from(0, 16);
        assert_eq!(got, b"1234");
        assert_eq!(slice_total, 4);
    }

    #[test]
    fn scrollback_read_from_returns_forward_window_not_tail() {
        // Codex P2 regression: the previous read_since returned the
        // *tail* of max_bytes regardless of the cursor, so paging from 0
        // skipped the head. Verify forward semantics: read(since=0,max=4)
        // on "0123456789" returns the head, not the tail.
        let mut sb = Scrollback::new(64);
        sb.append(b"0123456789");
        let (got, slice_total) = sb.read_from(0, 4);
        assert_eq!(got, b"0123");
        assert_eq!(slice_total, 0);
    }

    #[test]
    fn scrollback_read_from_at_or_past_total_is_empty() {
        let mut sb = Scrollback::new(64);
        sb.append(b"hi");
        let (got, slice_total) = sb.read_from(2, 16);
        assert!(got.is_empty());
        assert_eq!(slice_total, 2);
        let (got, _) = sb.read_from(99, 16);
        assert!(got.is_empty());
    }

    #[test]
    fn scrollback_incremental_cursor_walks_full_stream() {
        let mut sb = Scrollback::new(64);
        sb.append(b"hello ");
        sb.append(b"world!");
        // Drain incrementally with a tiny budget per call. With forward
        // paging, every byte is observed exactly once.
        let mut cursor = 0u64;
        let mut acc: Vec<u8> = Vec::new();
        for _ in 0..10 {
            let (got, slice_total) = sb.read_from(cursor, 4);
            if got.is_empty() {
                break;
            }
            assert_eq!(
                slice_total, cursor,
                "slice_total must equal cursor (forward paging)"
            );
            acc.extend_from_slice(&got);
            cursor = slice_total + got.len() as u64;
        }
        assert_eq!(&acc[..], b"hello world!");
    }

    #[test]
    fn scrollback_floor_blocks_pre_consent_bytes() {
        // End-to-end of the privacy contract: bytes appended *before* the
        // floor must never appear in a read snapshot, even if since_total
        // is 0 / unset.
        let mut sb = Scrollback::new(64);
        sb.append(b"SECRET-");
        let floor = sb.total_appended();
        sb.append(b"public");
        let cursor = floor; // caller would pass since_total=floor
        let (got, slice_total) = sb.read_from(cursor, 16);
        assert_eq!(got, b"public");
        assert_eq!(slice_total, floor);
    }

    #[test]
    fn scrollback_paging_no_cursor_then_resume() {
        // Mimics the cold-start use case: caller passes no cursor, gets
        // the latest `max_bytes`, then pages forward from the returned
        // cursor. This is the exact pattern shell_read_scrollback uses
        // when args.since_total is None.
        let mut sb = Scrollback::new(64);
        sb.append(b"hello world!");
        let max_bytes = 4usize;
        // Cold start cursor = total - max_bytes (clamped to oldest).
        let total = sb.total_appended();
        let cold_cursor = total
            .saturating_sub(max_bytes as u64)
            .max(sb.oldest_total());
        let (got, slice_total) = sb.read_from(cold_cursor, max_bytes);
        assert_eq!(got, b"rld!");
        assert_eq!(slice_total, 8);
        // Resume from after the returned slice — should be empty (caught up).
        let (got, _) = sb.read_from(slice_total + got.len() as u64, max_bytes);
        assert!(got.is_empty());
    }

    // ----- shell_write gate (M6 P2.2) ----------------------------------------

    /// Force a slot's share mode without a Tauri runtime. Mirrors what
    /// `shell_set_share_mode` does for tests.
    fn force_mode(reg: &ShellRegistry, tab_id: &str, mode: ShareMode) {
        let guard = reg.slots.lock().unwrap();
        let slot = guard.get(tab_id).expect("slot present");
        let mut s = slot.share.lock().unwrap();
        let total = slot.scrollback.lock().unwrap().total_appended();
        s.transition(mode, total);
    }

    #[test]
    fn write_keystrokes_rejects_private() {
        let reg = registry();
        let mut child = open_raw(&reg, "wp", "/bin/sleep", vec!["0.05".into()]);
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
        let mut child = open_raw(&reg, "wr", "/bin/sleep", vec!["0.05".into()]);
        force_mode(&reg, "wr", ShareMode::Read);
        let r = write_keystrokes(&reg, "wr", b"hi");
        assert!(r.is_err());
        let _ = child.wait();
        reg.slots.lock().unwrap().remove("wr").unwrap();
    }

    #[test]
    fn write_keystrokes_succeeds_for_read_write() {
        let reg = registry();
        let mut child = open_raw(&reg, "wrw", "/bin/sleep", vec!["0.05".into()]);
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
        let mut child = open_raw(&reg, "wrwt", "/bin/sleep", vec!["0.05".into()]);
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
