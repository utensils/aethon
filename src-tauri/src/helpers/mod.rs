//! Pure helpers extracted from `lib.rs` so they're testable without a
//! Tauri `AppHandle` or filesystem. Each submodule below holds one
//! well-defined slice; this `mod.rs` re-exports the flat
//! `helpers::*` surface that callers already depend on, so existing
//! `use crate::helpers::…` imports keep resolving unchanged.
//!
//! - [`config`] — `~/.aethon/config.toml` schema, `parse_config_toml`,
//!   the share-mode/new-tab-kind normalizers, and the numeric clamps
//!   (extension state limits + font size).
//! - [`paths`]  — `aethon_dir` user-dir resolution and the
//!   `resolve_inside_root` lexical traversal gate.
//! - [`names`]  — `validate_state_name` and `sanitize_filename_segment`,
//!   the leaf-filename guards.

pub mod config;
pub mod names;
pub mod paths;

// Flat re-exports of the surface external callers actually use. The
// underlying structs (`AethonConfig`, `UiConfig`, etc.) stay reachable
// via `helpers::config::*` for tests; pulling them up here would just
// generate dead-code warnings until something outside `helpers` needs
// them.
pub use config::{
    FONT_SIZE_MAX, FONT_SIZE_MIN, clamp_font_size, normalize_default_share_mode,
    normalize_devshell_enabled, normalize_devshell_mode, normalize_new_tab_kind,
    normalize_update_channel, normalize_tool_visibility, normalize_visibility,
    parse_config_toml,
};
pub use names::{sanitize_filename_segment, validate_state_name};
pub use paths::{aethon_dir, resolve_inside_root};
