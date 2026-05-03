//! PTY-backed user shell tabs (M6).
//!
//! Three submodules carve up the concern:
//!
//! - [`sharemode`] — the four-value `ShareMode` enum + `ShareState`
//!   privacy-floor logic. Pure data + transitions, no I/O.
//! - [`scrollback`] — the per-tab byte ring with a monotonic write
//!   cursor. Pure buffer; cursor math is in *byte* units to match what
//!   the bridge offers to the agent.
//! - [`lifecycle`] — `ShellRegistry`, the slot type, the reader thread,
//!   and every Tauri command. All OS-state ownership lives here.
//!
//! `lib.rs` imports `shell::*`; the re-exports below are the public
//! surface the Tauri builder hands to `invoke_handler`.

mod lifecycle;
mod scrollback;
mod sharemode;

// Glob re-export so `tauri::generate_handler![shell::shell_open, …]` in
// `lib.rs` resolves both the command function and the macro-generated
// `__cmd__*` / `__tauri_command_name_*` siblings the handler relies on.
pub use lifecycle::*;
