//! Nix devshell support: detect the project's devshell entry path
//! (`flake.nix`, `.envrc` with `use_flake`, or legacy `shell.nix`),
//! resolve the resulting environment once per (root, lockfile-hash),
//! cache it on disk under `~/.aethon/devshell-cache/`, and serve it
//! from a single source of truth to both the Rust-side PTY spawn
//! intercept and the agent's pi `bash` tool spawnHook.
//!
//! Layering:
//!
//! - [`detect`] — pure: which kind of devshell does this root have?
//!   No subprocesses; no I/O beyond reading the marker files.
//! - [`resolve`] — runs the kind-specific resolver command
//!   (`nix develop --command env -0`, `direnv exec env -0`, etc.) and
//!   parses the env output into a `BTreeMap`.
//! - [`cache`] — wraps both behind a non-blocking state machine and
//!   the on-disk snapshot store. Callers always see `Idle | Resolving
//!   | Ready | Failed` and never block on `nix`.
//!
//! The Tauri-command surface lives in [`crate::commands::devshell`].
//! The cache itself is held in Tauri managed state — see
//! [`crate::lib::run`] for the wiring.

pub mod cache;
pub mod config;
pub mod detect;
pub mod prepare_policy;
pub mod resolve;

pub use cache::{
    AppEmitter, DevshellCache, DevshellEmitter, EnvForPath, StatusSnapshot, evict_stale_snapshots,
};
pub use config::effective_config;
pub use detect::{DetectMode, detect_mode, forced_mode_mismatch};
pub use prepare_policy::{PrepareDecision, prepare_env_for_root};
