---
applyTo: "**/*.rs"
---

# Rust / Tauri shell review focus

## Shell-only logic

The Rust crate is a **thin Tauri shell**. Anything that isn't OS
boundary handling belongs in the bun agent bridge (`agent/`). Flag PRs
that grow `src-tauri/src/` with parsing, formatting, business rules,
or agent logic — that work goes in TypeScript.

## Concurrency

- The supervisor `Mutex<AgentProcess>` and `ShellRegistry` are the only
  sanctioned shared mutable state. New `static mut`, `lazy_static!` with
  mutable inner, or ad-hoc `Mutex`/`RwLock` outside these is a smell —
  ask why Tauri's `Manager`-managed state can't carry it.
- Reader threads (PTY output, child stdout) must hold a UTF-8 carry
  buffer across `read()` calls — see `src-tauri/src/shell/lifecycle.rs`.
  **Do not replace this with per-chunk `from_utf8_lossy`** — multi-byte
  sequences split across reads will corrupt.
- Avoid `block_on` inside Tauri command handlers; they already run on
  the Tokio runtime. Use `tauri::async_runtime::spawn_blocking` for
  CPU/IO work that would otherwise stall the IPC pool.

## Path safety

Every command in `src-tauri/src/commands/fs/` (and any new path-taking
command anywhere) **must** go through both gates:

1. `helpers::resolve_inside_root` — lexical `..`-traversal check that
   works on not-yet-existing paths.
2. Canonicalize the existing portion and re-check it's still inside
   root, to catch symlink redirects.

Reads/writes capped at `MAX_FILE_BYTES` (10 MB). Deletes must go to
the OS trash via the `trash` crate — never `std::fs::remove_*` for
user-visible files.

## Tauri plugin additions

A new plugin requires three coordinated edits:

1. `cargo add tauri-plugin-X --manifest-path src-tauri/Cargo.toml`
2. `.plugin(tauri_plugin_X::init())` in `src-tauri/src/lib.rs`
3. Permission entry in `src-tauri/capabilities/default.json`

Missing step 3 produces a silent runtime denial. Reviewers should
check the capabilities diff whenever the `Cargo.toml` plugin list
changes.

## Debug-only code

`src-tauri/src/debug.rs` (TCP eval server) is gated by
`#[cfg(debug_assertions)]`. Any new debug-only Tauri command must
carry the same gate — release builds must not ship an eval endpoint.

Webview-side dev globals (`window.__AETHON_STATE__`,
`__AETHON_INVOKE__`, `__AETHON_EXTENSION_REGISTRY__`, `__AETHON_SET_STATE__`)
are dev-only by convention. Don't reference them from production
paths.

## Logging

Use the `tracing` crate with target-scoped events. `AETHON_LOG`
honours `EnvFilter` syntax (e.g. `aethon::agent_watch=debug`).
`println!`/`eprintln!` in new code is a smell — flag it.

## Tests

`cargo test --lib` runs unit tests under `helpers/` (`#[cfg(test)] mod tests`
in each submodule — `paths.rs`, `names.rs`, `config.rs`).
Pure helper functions belong there. Tauri-command-shaped functions
that orchestrate state need integration coverage via the JS-side
debug skill, not Rust unit tests.

## Clippy

CI runs `cargo clippy -D warnings`. New `#[allow(clippy::...)]`
attributes need a one-line rationale comment.
