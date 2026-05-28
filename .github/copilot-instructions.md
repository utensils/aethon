# GitHub Copilot Code-Review Instructions

Aethon is a **Tauri 2 + React 19 + TypeScript + bun + Rust** desktop app whose
UI is rendered from agent-emitted A2UI JSON. This file tells Copilot how to
focus its code reviews. For deep architecture context that goes beyond
review scope, see [`CLAUDE.md`](../CLAUDE.md) and [`SPEC.md`](../SPEC.md) —
do not duplicate that material in review comments.

## Architectural invariants — flag any violation

These are load-bearing rules. PRs that break them must be flagged in review,
even if the change otherwise looks correct.

1. **Three-layer separation.** The Tauri shell (`src-tauri/`) owns OS
   boundaries only; the agent bridge (`agent/`) is JSON-lines over stdio;
   the React frontend (`src/`) renders A2UI payloads. **Business logic does
   not belong in the Rust shell.** Adding non-OS logic to `src-tauri/` is a
   review-blocker.
2. **A2UI is the entire UI.** The default layout is JSON in
   `src/extensions/default-layout/workstation.a2ui.json`, fed to the same
   renderer as agent output. **Do not introduce hardcoded chrome in
   `App.tsx`** — extend the layout JSON or register a new extension.
3. **Single state store, JSON-Pointer addressed.** Components read state
   via `$ref` JSON Pointers; the renderer applies optimistic writes back
   to those paths. Do not split state across multiple stores or hooks.
4. **Two registries, one rule.** The 19 primitives in
   `PRIMITIVE_REGISTRY` (`src/components/A2UIRenderer.tsx`; primitive
   components live under `src/components/primitives/`) **cannot be
   overridden** — everything else comes from `ExtensionRegistry`. New
   component types go on an extension, never into the primitive table.
5. **Per-tab `cwd` is immutable.** Tabs keep the working directory they
   were created with. PRs that mutate `tab.cwd` after creation are
   incorrect.
6. **No agent-driven `setShareMode`.** The user's badge click is the only
   path that flips a shell tab's share mode. Adding an agent-callable
   setter defeats the opt-in security boundary.
7. **Path-traversal guard on every filesystem command.** Any new command
   in `src-tauri/src/commands/fs/` (or anywhere accepting a path) must
   route through `helpers::resolve_inside_root` **and** canonicalize-then-
   recheck for symlinks. Skipping either layer is a security review block.
8. **No `--no-verify`, `--no-gpg-sign`, or other hook-bypass flags** in
   commits or scripts unless the PR description explicitly justifies it.

## Review priorities

Spend review effort on, in order:

1. **Security & boundaries** — path traversal, command injection,
   shell quoting in `agent/shell-tools.ts`, share-mode enforcement in
   `src-tauri/src/shell/sharemode.rs`, and any new IPC command exposed
   via Tauri's `invoke_handler` list.
2. **Cross-layer contracts** — the JSON-lines protocol between the Rust
   shell and the bun bridge (`agent/dispatcher.ts`), and the
   `agent-response` event payload shape consumed by `src/App.tsx`. Any
   change here must update both sides + at least one test.
3. **Concurrency / lifetime** — Rust `Mutex`/`Arc` patterns around
   `AgentProcess` and `ShellRegistry`, reader-thread UTF-8 carry buffers
   (in `src-tauri/src/shell/lifecycle/reader.rs` — do **not** replace with
   per-chunk `from_utf8_lossy`), and bun child reload via stdin sentinel
   instead of SIGKILL.
4. **Test coverage on touch** — every module under `agent/` has a
   colocated `*.test.ts`; routes under `src/eventRoutes/` need a
   happy-path test; new Rust helpers belong under `helpers/` with a
   `#[cfg(test)] mod tests`.
5. **Style / conventions** — Conventional Commits, two-space Nix indent,
   `import type { ... }` for type-only TS imports, no emojis in code or
   commits. ESLint is configured to error on **0 warnings**; new
   `eslint-disable` lines need a per-line rationale.

## Don't bikeshed

Skip review comments on:

- Whitespace, brace style, single-vs-double quotes — `treefmt` (`fmt`
  devshell command) is authoritative.
- File / folder naming if it already follows the directory's local
  convention.
- "Could be more abstract" suggestions when the change keeps the
  status-quo concrete shape (the project explicitly prefers concrete
  over speculative abstraction; see `CLAUDE.md`).
- Adding error handling for cases that can't happen (internal callers,
  framework guarantees).

## Keyboard shortcuts — three places to update in lockstep

A PR that adds or changes a keyboard shortcut **must** update all three:

1. The webview handler in `src/hooks/useKeyboardShortcuts.ts`
2. The native menu accelerator in `src-tauri/src/commands/extensions/app_menu.rs`
3. The palette listing in `src/extensions/default-layout/palette-items.ts`
   (`BUILTIN_KEYBINDINGS`)

Plus the canonical docs: `AGENTS.md`, `website/reference/keyboard-shortcuts.md`,
`website/guide/quick-start.md`, and `docs/aethon-agent/api.md`. Drift
between these is a frequent regression source — flag it in review.

## Tauri plugin additions — three-step pattern

Any new Tauri plugin requires:

1. `cargo add tauri-plugin-X --manifest-path src-tauri/Cargo.toml`
2. Register in `src-tauri/src/lib.rs` via `.plugin(tauri_plugin_X::init())`
3. Add the plugin's permissions to `src-tauri/capabilities/default.json`

Missing step 3 will silently fail at runtime. Always check the
capabilities file when reviewing plugin additions.

## CI gate

The single command `check` (from the Nix devshell) runs clippy, tsc,
ESLint, cargo test, and vitest. Reviewers should expect green
`check` on every PR. Local-only files (`run-phase*.sh`,
`aethon-phase*.png`) are gitignored ad-hoc test harness artifacts —
they must not appear in the diff.
