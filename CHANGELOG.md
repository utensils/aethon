# Changelog

All notable changes to Aethon. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Multi-tab sessions.** Per-tab pi `AgentSession` records sharing one
  `auth/registry/resourceLoader`. Each tab owns its own message history,
  draft, canvas, queue counter, terminal buffer, and model. `Cmd+T` new
  tab, `Cmd+] / Cmd+[` next/prev, `Cmd+W` close, plus a tab strip in
  the layout. New tabs inherit the active tab's model so the picker
  stays consistent. AsyncLocalStorage carries the active turn's tabId
  through the agent's async chain so concurrent prompts don't smear
  state across tabs.
- **Per-tab terminal buffer.** Bash output routes by tabId; switching
  tabs replays the right buffer into the shared xterm panel via a new
  `aethon:terminal-replay` event.
- **Native macOS menu bar.** `tauri::menu::MenuBuilder` replaces
  Tauri's auto-default. Standard NS items (Quit, Hide, Cut, Copy,
  Minimize, …) come from `PredefinedMenuItem` for free native
  behavior; app-specific items emit a `menu` Tauri event that converges
  with the existing keyboard shortcuts. Aethon / File / Edit / View /
  Tabs / Window submenus.
- **System tray icon.** Status-bar entry on macOS shows Aethon's brand
  mark in full color; left-click focuses the main window (re-surfacing
  Cmd+H'd apps); menu offers Show / New Tab / Quit.
- **Skill manifest discovery from `package.json#aethon`.** Bridge walks
  `~/.aethon/skills/node_modules/*` (and `@scope/*`) on boot and
  loads every package whose `package.json` declares an `aethon.entry`.
  Lets users `npm install --prefix ~/.aethon/skills <pkg>` to install
  third-party skills (see `examples/skill-package/`).
- **Extension hot-reload.** Bridge file watcher runs in dev AND
  release; watches `~/.aethon/extensions/`,
  `~/.aethon/skills/node_modules/`, `~/.pi/agent/extensions/`, and
  `<project>/agent/` (dev only). Trailing-edge debounce via a single
  worker thread (mpsc channel, `recv_timeout`) collapses npm-install
  bursts into one settle-then-fire kill. `~/.aethon/extensions` is
  pre-created on boot so first-install Create events fire.
- **Auto-updater wiring.** `tauri-plugin-updater` registered (gated on
  a non-empty `pubkey` so unconfigured builds boot safely),
  `updater_available()` Tauri command, "Check for Updates…" menu item,
  download-with-progress UI, and a `RELEASING.md` walkthrough for
  generating signing keys + GitHub Actions secrets. Activation
  requires the user to generate a keypair and paste the public key
  into `tauri.conf.json`.

### Fixed

- **Release `.app` no longer crashes on `npm root -g`.** macOS GUI apps
  inherit launchd's minimal PATH which doesn't include
  `~/.npm-global/bin`. Source the user's login shell once via
  `<shell> -ilc env` (POSIX, so it works for fish too) and inject the
  recovered PATH into the sidecar's environment.
- **Terminal panel no longer closes when you type into it.** Disabled
  xterm's stdin and onData wiring by default — there's no PTY backend,
  so accepting keystrokes only confused users into thinking the panel
  was broken.
- **Slash commands no longer leave their text "stuck" in the input.**
  The slash-command path now clears via `updateActiveTab` so the next
  mirror doesn't write the stale draft back into root.

### Changed

- **Tray icon shows the full-color brand mark** instead of a
  monochrome template (the template treatment was stripping the orange
  and losing the identity).
- **Terminal panel header** simplified to "Aethon Terminal" (was
  "Terminal" + "xterm.js · WebGL" badge).
- **`SPEC.md` checklist** reconciled with what's actually shipped.

[Unreleased]: https://github.com/utensils/aethon/compare/v0.1.0...HEAD
