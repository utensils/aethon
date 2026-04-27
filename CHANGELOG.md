# Changelog

All notable changes to Aethon. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Mutation feedback channel.** Every mutating outbound bridge → frontend
  message (`state_patch`, `layout_set`, `layout_patch`,
  `extension_components`, `extension_themes`) now carries a `mutationId`.
  The frontend acks via `mutation_ack { mutationId, success, error? }`,
  and the bridge resolves a per-mutation Promise so the public API
  (`aethon.setState`, `aethon.setLayout`, `aethon.patchLayout`,
  `aethon.registerComponent`, `aethon.registerTheme`,
  `aethon.registerSidebarSection`) returns `Promise<{ok: boolean,
  error?: string}>`. Backwards compatible: sync callers ignore the
  Promise and behave exactly as before. Failure modes: `timeout` (5 s
  no ack), `frontend_rejected: <detail>`, bridge-side validation. Calls
  made before the frontend has reported `ready` resolve immediately
  with `{ok: true}` so register-time awaits don't block on the cold-start
  webview. System prompt + bundled docs (`docs/aethon-agent/api.md`)
  document the contract.
- **`eventHandlers` in `RuntimeSnapshot` and `~/.aethon/state.json`.**
  Match-shape only (templateRootType / componentType / descendantId /
  eventType) — no function bodies, so the snapshot stays small and
  serializable. Surfaced in the system prompt's runtime section so the
  agent can answer "what onEvent handlers are wired?" without invoking
  JS or scraping the registry.
- **`BuiltinComponentProps.onEvent` 3rd-arg `descendantId`.** Composites
  that render their own per-row controls (sidebar items, list rows) can
  emit events tagged with a stable child id. The renderer rewrites the
  outbound componentId to `<host>__tpl__<descendantId>` so the bridge's
  existing `__tpl__` parser populates `match.descendantId` exactly as it
  does for template-expanded children. Fixes the documented sidebar
  matcher recipe (`{componentType:"sidebar", descendantId:"open-readme"}`)
  that previously never matched.
- **System-prompt section: "A2UI templates do not iterate arrays."**
  Until the `for-each` primitive lands, the prompt explicitly tells the
  agent that dynamic lists require regenerating the subtree on each
  mutation via `patchLayout`, with a worked example. Saves a debugging
  round-trip when the agent tries to bind a `$ref` to an array of
  children.

### Changed

- **`button` fires `click` unconditionally** (no longer gated on the
  `props.onClick` flag, which has been removed from the schema). Disabled
  buttons remain inert. Agent-authored buttons that follow the bundled
  docs now actually emit events on click.
- **Handler `ctx.pi.prompt` errors emit `notice`, not `error`.** Sending
  `error` from a failed handler-prompt was clearing the frontend's
  `waiting` flag and hiding the Stop button on whatever turn the user
  actually had running. Notice is non-terminal so the surrounding turn's
  UI stays intact; the error still rethrows so the calling handler sees
  it.
- **`registerComponent` accepts both bare and wrapper template shapes.**
  Bridge auto-unwraps `{components:[<single component>]}` to the single
  component the renderer expects. Docs (`api.md`) updated to show the
  bare-component form as canonical; wrapper form remains for back-compat
  with existing extensions.

### Added

- **`getLayout()` returns the active rendered layout.** Bridge now
  preloads the canonical boot layout synchronously from
  `$AETHON_BOOT_LAYOUT_FILE` (set by the Tauri shell, pointing at the
  default-layout JSON in dev or the bundled resource in release) BEFORE
  any extension's `register(api)` runs. `_getLayout()` returns
  `extensionLayout ?? (bootLayout + pendingLayoutPatches folded)` so
  extensions inspecting at register-time see the real tree, not `null`.
  Closes the release-mode bug where `right-sidebar-model-picker` bailed
  out on its first line because `api.getLayout()` returned null. Boot
  layout is now also a Tauri bundle resource so release builds get it.
- **`AETHON_BOOT_LAYOUT_FILE` env var** added to the bridge contract
  alongside `AETHON_DOCS_DIR` etc.
- **`boot_layout` inbound bridge message** lets the frontend refresh
  the bridge's view of the boot layout when the active layout skill
  changes (skill swap → new boot tree).

### Changed

- **`~/.aethon/state.json` now updates on `onEvent` registration** so
  the snapshot reflects newly-wired handlers, not just registered
  components/themes/layouts.
- **`~/.pi/agent/extensions/` is pre-created on boot** so a first-time
  pi extension drop fires Create events and hot-reloads without a
  manual app restart (parity with `~/.aethon/extensions/`).

- **Persistent per-tab pi sessions.** Each tab uses
  `SessionManager.continueRecent($AETHON_SESSIONS_DIR/<tabId>)` instead
  of `inMemory()`, so the model's conversation history survives bun
  restarts (file-watcher in dev, app relaunch in release). Closes the
  "I have no context from a previous session" gap that surfaced when
  the bridge respawned mid-conversation.
- **Live runtime snapshot in the agent's system prompt.** Bootstrap
  reordered so extensions load **before** the default tab — pi's
  `appendSystemPromptOverride` callback then sees a fresh
  `getRuntimeSnapshot()` (loaded extensions, themes, custom A2UI
  components, layout summary, open tabs) and bakes it into the first
  session's prompt. The agent can answer "what extensions are loaded?"
  on its first turn without scraping the filesystem.
- **Bundled reference docs.** `docs/aethon-agent/{api,components,extensions}.md`
  ship inside the binary via `tauri.conf.json` `bundle.resources`, and
  the spawn env exports `AETHON_DOCS_DIR` so the system prompt and
  agent `read` calls reach them in any build mode.
- **`~/.aethon/state.json` live snapshot.** Bridge writes the full
  runtime registry (extensions, themes, components, layout summary,
  tabs) to disk debounced 200 ms on every register* call. The system
  prompt instructs the agent to `cat $AETHON_STATE_FILE` for an
  always-fresh view.
- **Introspection methods on `globalThis.aethon`.** `listExtensions`,
  `listComponents`, `listThemes`, `getLayout`, `getRuntimeSnapshot`
  give the agent in-process queries over the same data the state file
  exposes.
- **Pi extension discovery.** `discoverPiAethonExtensions` greps
  `~/.pi/agent/extensions/*.{ts,js,mjs}` for `globalThis.aethon` /
  `aethon.register` references and lists the matches in the runtime
  snapshot tagged `pi-extension`. Pi loads them itself; we just record
  their existence so the agent's "what's loaded?" answer covers all
  UI-driving sources.
- **Bridge env-var contract.** Tauri shell sets `AETHON_DOCS_DIR`,
  `AETHON_USER_DIR`, `AETHON_STATE_FILE`, `AETHON_SESSIONS_DIR`,
  `AETHON_RELEASE_MODE`, and `AETHON_PROJECT_ROOT` (dev only) when
  spawning the agent. System prompt branches on these so release
  builds don't tell the model to read source files that aren't there.
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
- **Agent in release mode no longer tries to edit Aethon source.**
  `AETHON_RELEASE_MODE=1` flips a system-prompt branch instructing the
  model to use `$AETHON_USER_DIR/extensions/` (or skill packages)
  rather than touching source files that aren't shipped with the
  bundle.
- **Agent now knows what extensions are loaded.** Static system prompt
  + per-session runtime snapshot + on-disk state file + introspection
  API combine so "list loaded extensions" / "what themes are
  registered?" answers correctly on the first turn instead of
  filesystem-scraping or hallucinating.

### Changed

- **Tray icon shows the full-color brand mark** instead of a
  monochrome template (the template treatment was stripping the orange
  and losing the identity).
- **Terminal panel header** simplified to "Aethon Terminal" (was
  "Terminal" + "xterm.js · WebGL" badge).
- **`SPEC.md` checklist** reconciled with what's actually shipped.

[Unreleased]: https://github.com/utensils/aethon/compare/v0.1.0...HEAD
