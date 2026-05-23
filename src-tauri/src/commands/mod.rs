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
//! - [`git`] — sidebar git status + project picker.
//! - [`window`] — fullscreen / DevTools / updater gating.
//!
//! `tauri::generate_handler!` in `lib.rs` references each command via
//! its full module path so the macro-generated `__cmd__*` siblings
//! resolve correctly.

pub mod config;
pub mod extensions;
pub mod fs;
pub mod git;
pub mod host;
pub mod server;
pub mod session;
pub mod window;
