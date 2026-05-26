//! PTY-backed user shell tabs (M6 P1/P2).
//!
//! One [`ShellSlot`][registry::ShellSlot] per tab id: a
//! [`portable_pty`] master, a writer handle for keystrokes, an
//! `Arc<Mutex<Option<Box<dyn Child>>>>` for the child process, and a
//! reader thread that streams stdout to the frontend as
//! `shell-output {tabId, content}` events. When the child exits
//! naturally the reader sees EOF, calls `Child::wait`, and emits
//! `shell-exit {tabId, code}` once. [`shell_close`] kills the child
//! and drops the PTY so the reader unblocks for clean shutdown on tab
//! close — no zombie processes.
//!
//! The single 1k-LOC `lifecycle.rs` was retired in favour of five
//! focused submodules:
//!
//! - [`registry`] — `ShellSlot`, `ShellRegistry`, per-handle type
//!   aliases, the `SCROLLBACK_BYTES` cap, and `#[cfg(test)]` helpers
//!   used by sibling tests.
//! - [`open`] — `shell_open`, `ShellOpenArgs`, default-shell picking.
//! - [`io`] — `shell_input`, `shell_resize`, `shell_close` (the user's
//!   ungated PTY control surface).
//! - [`reader`] — `spawn_reader_thread`, UTF-8 codepoint-safe split,
//!   and OSC 0/1/2 title parsing.
//! - [`sharing`] — the `ShareMode` machinery.
//!   `shell_set_share_mode` is user-gesture-driven (the badge); it is
//!   intentionally **not** exposed through the agent bridge so the
//!   agent can't escalate its own access. The three agent-facing
//!   commands `shell_list_shareable`, `shell_read_scrollback`, and
//!   `shell_write` ride the same plumbing as
//!   `aethon.shells.{list,read,write}`. `write_keystrokes` is the
//!   internal `ShareMode`-gated helper used by `shell_write`.
//!
//! `lib.rs` continues to import `shell::{ShellRegistry, shell_open,
//! ...}` — the glob re-export here, combined with the one in
//! `shell::mod`, preserves the public surface.

mod open;
mod reader;
mod registry;

pub mod io;
pub mod sharing;

// Glob re-exports so `tauri::generate_handler![shell::shell_open, ...]`
// in `lib.rs` resolves both each command function and the
// macro-generated `__cmd__*` / `__tauri_command_name_*` siblings the
// handler relies on. Same pattern as `commands/fs/mod.rs` and
// `commands/extensions/mod.rs`.
pub use io::*;
pub use open::*;
pub use registry::ShellRegistry;
pub use sharing::*;
