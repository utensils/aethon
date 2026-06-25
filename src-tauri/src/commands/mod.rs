//! Tauri IPC commands grouped by concern.
//!
//! Each submodule owns a slice of the frontend-callable surface so
//! `lib.rs` can stay focused on agent process management, runtime
//! initialization, and the `tauri::Builder` wiring. The split mirrors
//! the shell submodule layout that landed in PR #49 (Phase 5).
//!
//! - [`config`] — `~/.aethon/` state files + `config.toml` round-trip.
//! - [`session`] — pi session search / delete / chat export.
//! - [`extensions`] — extension menu items, native menu + tray, agent
//!   file-watcher, npm extension installer.
//! - [`git`] — local git status, worktrees, GitHub data, issues, and picker.
//! - [`native_windows`] — restorable native canvas windows.
//! - [`window`] — fullscreen / DevTools / updater gating.
//! - [`updater`] — channel-aware update check + install + boot probation
//!   prepare.
//! - [`boot`] — `boot_stage` / `boot_ok` IPC for post-update rollback ack.
//!
//! `tauri::generate_handler!` in `lib.rs` references each command via
//! its full module path so the macro-generated `__cmd__*` siblings
//! resolve correctly.

pub mod boot;
pub mod config;
pub mod devshell;
pub mod extensions;
pub mod fs;
pub mod git;
pub mod host;
pub mod mcp;
pub mod native_windows;
pub mod scheduler;
pub mod server;
pub mod session;
pub mod setup;
pub mod startup;
pub mod subagents;
pub mod updater;
pub mod voice;
pub mod window;
