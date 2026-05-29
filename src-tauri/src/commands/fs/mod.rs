//! Project-scoped file-system commands for the Monaco editor + file tree.
//!
//! Each command takes an absolute `root` (the active project's cwd) plus
//! an absolute target `path`. We refuse to touch anything that lexically
//! escapes `root`, then canonicalize the existing portion of the path
//! and refuse again if a symlink redirects out. The two layers (lexical
//! + symlink-aware) live in [`security`]; every other submodule consumes
//!   them through `pub(super)` helpers.
//!
//! All read/write goes through `std::fs`; no `tauri-plugin-fs`. That
//! plugin's allow-list lives in a capability JSON file at build time —
//! awkward for a per-project root the user picks at runtime. Hand-rolling
//! is simpler and keeps the trust boundary in one place.
//!
//! Deletes go to the OS trash via the `trash` crate, with a home-trash
//! rename fallback for platform trash failures. The user can always
//! recover, which matches Aethon's general "don't lose user work" stance.
//!
//! Submodule layout:
//!
//! - [`security`] — path validation + size cap
//! - [`listing`]  — non-recursive directory read + project-wide walk
//! - [`watch`]    — file-tree change watcher + state
//! - [`io`]       — read / write / create / rename
//! - [`trash`]    — delete with OS-trash + `~/.Trash` fallback
//! - [`open`]     — reveal / open in native file manager + default app

mod security;

pub mod icons;
pub mod io;
pub mod listing;
pub mod open;
pub mod trash;
pub mod watch;

// Glob re-exports so `tauri::generate_handler![commands::fs::fs_…, …]`
// in `lib.rs` resolves both each command function and the macro-generated
// `__cmd__*` / `__tauri_command_name_*` siblings the handler relies on.
pub use icons::*;
pub use io::*;
pub use listing::*;
pub use open::*;
pub use trash::*;
pub use watch::*;
