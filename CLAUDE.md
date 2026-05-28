# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Aethon is a Tauri 2 + React + TypeScript desktop app. See `SPEC.md` for the
design vision and milestone checklist; `RELEASING.md` for the release flow.

The Tauri shell is intentionally thin — the Rust side handles OS boundaries
and the React frontend renders A2UI payloads emitted by a TS agent
subprocess. Business logic belongs in the agent, not the shell.

## Stack

- **Backend**: Rust + Tauri 2 (crate `aethon`, lib `aethon_lib`)
- **Frontend**: React 19, TypeScript, Vite, bun
- **Agent**: `@mariozechner/pi-coding-agent` run as a `bun` subprocess
- **Dev env**: Nix flake (flake-parts + numtide/devshell + treefmt-nix +
  rust-overlay). Rust pinned to **1.92.0** in `flake.nix`; bumping past 1.95
  currently breaks `icu_provider` / `regex-automata` / `objc2` transitive
  deps. `rust-toolchain.toml` is for non-Nix builds; the Nix pin wins inside
  the devshell.

## Common commands

Run inside `nix develop` (direnv auto-activates via `.envrc`). Devshell
helpers (defined in `flake.nix`):

| Command     | What it does                                                              |
| ----------- | ------------------------------------------------------------------------- |
| `dev`       | `scripts/dev.sh` → `cargo tauri dev` with port auto-increment             |
| `docs`      | `vitepress dev` from `website/` bound to `0.0.0.0` (LAN-reachable; :5173) |
| `build-app` | `cargo tauri build` — release bundle                                      |
| `check`     | CI gate: clippy + tsc + ESLint + cargo test + vitest                      |
| `lint`      | ESLint (no auto-fix)                                                      |
| `test`      | `cargo test --lib` + `bunx vitest run`                                    |
| `coverage`  | TS coverage report (vitest v8) → `coverage/`                              |
| `fmt`       | treefmt (rustfmt + nixfmt + prettier + taplo)                             |

ESLint is configured for **0 errors and 0 warnings**.

Single tests:

- TS file: `bunx vitest run agent/terminal-stream.test.ts`
- TS by name: `bunx vitest run -t "test name pattern"`
- Rust: `cargo test --lib -p aethon -- helpers::test_name`

E2E (`bun run test:e2e`, see `e2e/aethon.spec.ts` + `playwright.config.ts`):
the harness mocks one Tauri webview per test but shares a single Vite dev
server, so tests run **serial** — a reload in one page can interrupt another.
Set `VITE_PORT` to follow `scripts/dev.sh`'s chosen port.

Version sync: `bun run build` runs `version:check` (`scripts/sync-version.mjs`)
to keep `package.json` / `Cargo.toml` / `tauri.conf.json` aligned. Drift fails
the build — run `bun run version:sync` to fix. `scripts/build-updater-manifest.sh`
generates the updater JSON consumed by `useUpdater` (see release flow).

`scripts/dev.sh` flags:

- `dev --new` — sandbox launch under `${TMPDIR}/aethon-dev/new-<pid>/`
  (empty `~/.aethon`, removed on exit). Resolver is `helpers::aethon_dir`,
  honored by config / sessions / pastes / logs / window state / extensions.
- `dev --clean` — wipe `${TMPDIR}/aethon-dev/` and exit.

Vite defaults to port 1420 but `scripts/dev.sh` auto-increments and writes
the chosen Vite + debug ports to `~/.aethon/dev-info.json`; `strictPort: true`
stays on. The `aethon-debug` skill reads `dev-info.json` to follow the port.

## Architecture

Three layers:

1. **Tauri shell** (`src-tauri/src/`). `lib.rs` is the thin entry (`run()`
   builder, plugin + managed-state registration). The agent supervisor
   lives in `agent_process/` (`AgentProcesses` managed state, plus
   `spawn`/`readers`/`sidecar`). IPC commands under `commands/`: `boot`,
   `config`, `extensions/`, `fs/`, `git/`, `host`, `server`, `session`,
   `updater`, `window`. Shell-tab PTY logic under `shell/` (`lifecycle`,
   `scrollback`, `sharemode`). Window geometry in `window_state/`. Pure
   helpers in `helpers/` (`paths`, `names`, `config`). Discovery/HTTP
   server in `server/` (see below). Debug-only TCP eval server in
   `debug.rs` (gated by `cfg(debug_assertions)`).

   Core agent commands: `send_message` (forwards chat to agent stdin),
   `dispatch_a2ui_event` (forwards a structured event). First call spawns
   `bun run agent/main.ts` and starts a reader thread emitting `agent-response`
   Tauri events per stdout line. Shell-tab commands (`shell_open/input/
resize/close`) sit behind a `ShellRegistry` (per-tab `portable-pty` +
   reader; emits `shell-output` / `shell-exit`).

   The PTY reader preserves UTF-8 boundaries across reads via a carry buffer
   - `Utf8Error::error_len()` split — **do not replace with per-chunk
     `from_utf8_lossy`**; multi-byte sequences will corrupt.

2. **Agent bridge** (`agent/`). JSON-lines over stdio. `main.ts` is a thin
   entry; the readline loop and dispatcher live in `dispatcher.ts`. State is
   the `AethonAgentState` class in `state.ts`. The bridge attaches
   `globalThis.aethon` (built in `aethon-api.ts`) so pi tools and extensions
   can mutate UI, register components/themes/keybindings, push notifications,
   and introspect.

   Each module has a colocated `*.test.ts`. Provider config comes from env
   (`ANTHROPIC_API_KEY` etc.); pi-ai picks one up.

3. **React frontend** (`src/`). `App.tsx` is a thin shell composed of
   `useX()` hooks (`src/hooks/`). Event routing lives in `src/eventRoutes/`
   (one file per prefix family, with sidebar subroutes under
   `src/eventRoutes/sidebar/`). Root overlays are composed by
   `useUiOverlays` from `src/hooks/uiOverlays/{settings,search,palette}`.
   The `window.aethon` runtime API is built in `src/runtime/windowApi.ts`.

### Frontend model — three things to know

**1. Layout-as-payload.** The default UI is _not_ hardcoded React —
it's `src/extensions/default-layout/workstation.a2ui.json`, fed to the same
`A2UIRenderer` that handles agent output. Don't add static chrome in
`App.tsx`; extend the layout JSON or register an extension. Layouts must
match the slot contract in `src/extensions/default-layout/slots.ts`
(canonical slots: `header`, `sidebar`, `canvas`, `composer`, `terminal`,
`status`); non-canonical layouts declare a `slotMap`.

**2. Single state store, JSON Pointer addressed.** All app state lives in
one object on `App`. Components read it via `$ref` JSON Pointers
(`{"value": {"$ref": "/draft"}}`). The renderer applies an _optimistic_
write back to that path for `change`/`submit` events on `$ref` inputs —
see `applyOptimisticUpdate` in `A2UIRenderer.tsx`. Pointer helpers in
`src/utils/jsonPointer.ts` + `src/utils/dataBinding.ts`.

**3. Two registries.**

- Primitive React components (`src/components/primitives/`) are
  re-exported through `src/components/builtins.tsx` and wired into a
  hardcoded 19-entry `PRIMITIVE_REGISTRY` in
  `src/components/A2UIRenderer.tsx`. **Cannot be overridden by extensions.**
- Everything else (chrome composites like `sidebar`, `chat-input`,
  `command-palette`, `terminal-panel`, `tab-strip`, `shell-canvas`, etc.)
  comes from `ExtensionRegistry`. Mount via `<RegistryComponent type="…" />`
  so an extension can swap them with `aethon.registerComponent`. New types
  go on an extension, not in the primitives table.

### Event routing

`A2UIRenderer` accepts `onEvent`. Returning `true` marks an event handled
and suppresses the default `dispatch_a2ui_event` forward to Rust.
`App.tsx` delegates to `dispatchEvent` in `src/eventRoutes/index.ts`,
with three precedence layers:

1. Reserved shell-consent prefixes (`shell-write` / `shell-close` /
   `session-delete`) MUST resolve before extension matchers.
2. Extension-registered routes (returning `false` forwards to the bridge).
3. Built-in routes keyed by `id:<componentId>` or `type:<componentType>`.

**Always key chrome composites by `type:`, not `id:`** — that's how
`registerComponent("<type>", custom)` and renamed instances stay routable.
New handlers go in `eventRoutes/<name>.ts` + a happy-path test, then
register in `BUILTIN_ROUTE_TABLE`.

### Runtime API

`window.aethon` exposes: `setLayout`, `resetLayout`,
`registerLayout({id, name, payload})` (id pattern `/^[A-Za-z][\w-]*$/`;
`workstation` is reserved), `activateLayout`, `registerExtension`,
`listExtensions`, `openProject`. Mirrored agent-side on `globalThis.aethon`
(see `agent/aethon-api.ts`).

Per-surface subnamespaces, each backed by a `*_query` bridge message:

- `aethon.shells.{list, read, write}` — opt-in shell sharing.
- `aethon.tasks.start({projectPath, prompt, newWorktree?, branch?, baseBranch?})`
  — task launcher parity.
- `aethon.dashboard.{getRepoOverview, refresh, listIssues, getIssue}` —
  cached gh repo data + issues.

Pre-frontend-ready callers of `*_query` block until the handshake
completes — queries need real `data`, not the side-effect-mutation
shortcut. Do **not** add a fast-path letting the bridge invoke Tauri
commands directly; security floors live with the data source.

### Tab kinds + terminal panel

`Tab.kind` is `"agent" | "shell"`. The top tab strip carries only agent
tabs (shells are filtered). The bottom panel (toggle `` Cmd+` ``) hosts
two sub-tab kinds: the always-present read-only `agent-bash` stream
(buffered tool stdout) and zero or more interactive `portable-pty` shells
(TUI-capable, 256-color, mouse). State paths: `/terminalPanel/activeSubId`
(defaults `"agent-bash"`), `/terminal/open`. Shells live in `/tabs` with
`kind === "shell"`; the renderer routes them to the right surface via
`/agentTabActive` / `/shellTabActive` derived flags in
`workstation.a2ui.json`.

`Cmd+T` is focus-aware: focus inside the bottom panel = new shell sub-tab;
elsewhere = new agent tab. `Cmd+Shift+T` always spawns a new shell sub-tab.

Per-tab `ShareMode` is the security boundary, enforced Rust-side in
`shell/sharemode.rs`. The bridge surface (`aethon.shells.*`) rounds through
the mutation-ack channel. **Do not add an agent-driven `setShareMode`** —
discoverable tab ids + a setter would defeat the opt-in floor that `list()`
enforces. Writes pop an Allow/Deny notification in `read-write` mode;
`read-write-trusted` bypasses the prompt.

### Hot reload doesn't kill in-flight prompts

The Rust file-watcher (`commands/extensions/reload.rs::run_debounce_worker`,
wired from `commands/extensions/watcher.rs`) writes
`{"type":"reload_request"}` to the child's stdin instead of
SIGKILL. The bridge drains active `tab.promptInFlight`, emits a
`{"type":"_reload_done"}` sentinel, and exits. The supervisor's reader
peeks for the sentinel, emits `agent-reloaded`, and respawns on the next
IPC call. Extension drops never abort the user's LLM turn. The hard-kill
fallback remains for wedged stdin.

`touch agent/main.ts` is the simplest manual restart.

### File-system safety (commands/fs/)

Two layers gate every path: lexical (`helpers::resolve_inside_root`)
catches `..` traversal without hitting disk; canonicalize-after-existing
catches symlinks redirecting outside the project root. Read/write caps
at 10 MB. Deletes go to the OS trash via the `trash` crate — never
`unlink`.

### Window geometry

`src-tauri/src/window_state/` (`schema`, `restore`, `save`,
`monitor_matching`, `migration`, `persistence`) persists position/size/maximized to
`~/.aethon/window-state.json` in **logical** units (physical pixels are
not portable across HiDPI). Restore runs in `setup()` before the window
becomes visible (`tauri.conf.json` sets `visible: false`). Save is
250 ms debounced on Moved/Resized; flushed synchronously on
CloseRequested. Monitor matching is three-tier (exact → intersects →
nearest by saved center) with titlebar-reachability clamp. Fullscreen
is transient and skipped. v0 (physical) files migrate to v1.

### Projects + worktrees

Pi sessions are scoped to a cwd. `src/projects.ts` persists the project
list at `~/.aethon/projects.json` (max 16, MRU, schemaVersion 2; v1→v2
migrates on read). **Existing tabs keep the cwd they were created with**
— switching the active project only affects new tabs. Worktrees attach
via `src/worktrees.ts`, with Rust commands in `commands/git/`. Active
worktree is mirrored to `/activeWorktreeId` so the file tree and new
tabs follow the sidebar selection.

### Dashboard caches (M9)

- `src/ghRepoOverviewCache.ts` — 5-min live TTL, 30-min negative.
- `src/ghIssuesCache.ts` — 90-s live, 60-s negative; cap clamped to 100.

Use `gh issue list -q length` for the open-issue count, **not**
`open_issues_count` (that counts PRs + issues). Percent-encode branch
names with slashes before hitting `repos/<r>/branches/{x}`.

### Networked discovery (server/)

`src-tauri/src/server/` is a scaffold daemon (Claudette-style) wired in
`setup()` and torn down on exit. Two `mdns_sd::ServiceDaemon`s run side
by side: one **advertises** `_aethon._tcp.local.` with the bound HTTP
port in TXT, the other **browses** and emits Tauri events
`host-discovered` / `host-removed`. An axum server binds `0.0.0.0:0`
(OS picks the port) exposing `GET /health` + `GET /status`. **No auth,
no TLS** — this is explicit scaffolding for an upcoming pairing PR;
do not lean on it for trusted IPC. `commands/server.rs` exposes
`server_start` / `server_stop`; `commands/host.rs` surfaces discovered
peers to the frontend. **No config gate today** — `boot()` spawns both
HTTP and mDNS unconditionally during Tauri `setup()`; a `[server]
enabled` toml flag is planned alongside the pairing PR but not wired
yet. The browser keeps running with the advertiser off — discovery is
read-only and useful in isolation.

### Auto-updates + boot probation

Auto-update lives in three files:

- `src-tauri/src/commands/updater.rs` — `check_for_updates_with_channel`
  - `install_pending_update`. Channel-aware (stable / nightly) with
    GitHub-API discovery that prefers the freshest nightly and falls back
    through the previous two tags. The downloaded `Update` is stashed in
    `UpdaterState::pending_update` until install fires (it isn't
    `Serialize` so it can't cross IPC).
- `src-tauri/src/boot_probation.rs` — pre-install backup + post-launch
  rollback timer. `install_pending_update` calls `prepare_for_update`
  inside `spawn_blocking` to copy the current `.app` to
  `~/.aethon/updates/previous/<version>/`. `setup()` reads the
  sentinel, arms a `MAX_PROBATION_ATTEMPTS`-bounded timer, and on
  timeout spawns `--boot-rollback-helper` to restore the backup. The
  helper short-circuits at the top of `run()` before Tauri builds.
- `src/hooks/useUpdater.ts` — 30-min background poll + manual menu
  trigger. Calls `boot_stage("react_mounted")` + `boot_ok` on first
  paint to cancel the rollback timer. `UpdateBanner` reads the hook
  state and renders chrome above the layout.

Channel is persisted at `[updates] channel = "stable"|"nightly"` in
`~/.aethon/config.toml`; Settings → Updater toggles it. Override the
probation window with `AETHON_BOOT_PROBATION_SECS` (clamped [1, 120]).

### Nix devshell wrap (shells + agent bash)

Project roots with `flake.nix`, `.envrc` (`use_flake`/`use_nix` + the
`direnv` binary), or `shell.nix` get their devshell env auto-applied
to **both** interactive PTY shell tabs and the agent's pi `bash` tool.
One source of truth feeds both:

- `src-tauri/src/devshell/{detect,resolve,cache}.rs` — capability-aware
  detection (direnv > flake > shell.nix, refuses to claim a kind we
  can't resolve), `nix print-dev-env --json` / `direnv exec env -0`
  / `nix-shell --run` resolvers, SHA1 fingerprint over `flake.lock`
  bytes + marker-file (size, mtime). In-memory state machine
  (`Idle | Resolving | Ready | Failed` with 30 s failed-backoff),
  on-disk snapshots at `~/.aethon/devshell-cache/<short-hash>/`.
  Concurrent shell opens collapse onto a single in-flight resolver
  via a per-slot `tokio::sync::Notify`.
- `src-tauri/src/commands/devshell.rs` — `devshell_status` (badge),
  `devshell_env_for_path` (spawnHook), `devshell_refresh`
  (Settings + future file-watcher). Honours `[devshell] enabled =
"never"` as an unconditional short-circuit. Per-project override
  at `<project>/.aethon/devshell.toml` merges over the global section.
- PTY intercept in `shell/lifecycle/open.rs` — applies the resolved
  env **after** `TERM`/`COLORTERM`/`AETHON` and **before** `args.env`
  so explicit per-tab env keeps winning. Lookup is non-blocking; a
  cold cache returns empty and the shell spawns unwrapped while the
  background resolver runs (next open in the same tab gets wrapped).
- Agent intercept is a `customTools` entry with `name === "bash"` —
  pi-coding-agent's tool registry uses later-wins-by-name in
  `_refreshToolRegistry`, so passing a `bash`-named `ToolDefinition`
  via `customTools` shadows the built-in (no fork of pi needed). The
  shadow gets pi's exposed `BashSpawnHook` attached, which reads a
  process-local cache in `agent/devshell/client.ts` warmed via the
  `devshell_query` bridge IPC and invalidated when the frontend
  forwards `devshell-ready` / `devshell-failed` push events as
  `devshell_event` messages.
- Frontend chrome: status-bar `⬡ <kind>` chip reads from
  `/devshell/{activeRoot, entries[]}`, populated by
  `src/hooks/useDevshell.ts` (Tauri-event listener + agent forwarder).
  Settings → Nix devshell section exposes `enabled`, `mode`,
  `cache_ttl_hours`, `refresh_on_lockfile_change`, and a live
  "Refresh now" button.

Override per project with `[devshell] enabled = "never"` in
`<root>/.aethon/devshell.toml`. Use `AETHON_LOG=aethon::devshell=debug`
to see resolver timing.

### Voice-to-text input

Composer dictation lives Rust-side. `src-tauri/src/voice.rs` runs a local
Whisper model (`candle-transformers`) as one provider; `voice/audio.rs`
is the `cpal` recorder (level-metering task + WAV capture). The other
providers are native OS recognizers behind `platform_speech.rs`'s
`PlatformSpeechEngine` trait — macOS `SFSpeechRecognizer`/`SpeechAnalyzer`
(driven by a small Swift static lib compiled in `build.rs`), Windows
SAPI 5.4 via COM (`windows` crate, no .NET/PowerShell), Linux a stub.
All providers consume the same `CapturedAudio` PCM buffer, so `voice.rs`
holds a `&dyn PlatformSpeechEngine` and needs no per-OS branching.
`commands/voice.rs` exposes the IPC surface: provider
list/select/enable, model `prepare`/`remove` (Whisper weights are
downloaded on demand), and `start_recording` /
`stop_and_transcribe` / `cancel_recording`.

### Auth profiles (multi-account login)

Per-tab login identities, so different agent tabs can authenticate as
different accounts. State is `agent/auth-profiles/` (store + manager):
each profile is `oauth | api_key`, scoped to a provider, with per-tab
active-profile and per-provider default. Profile ids are sanitized
(`isSafeProfileId` / `sanitizeProfileId`) before touching disk;
credentials live under `authProfilesDir()` in `~/.aethon/`. The login
flow streams an `AuthProfileLoginEvent` (`started → auth → progress →
prompt → complete`) so the OAuth challenge surfaces in the UI. Frontend
mirror is `src/auth-profiles/` (`types`, `commands`, `index`); the
active profile selects which model registry a tab sees
(`modelRegistryForModelId`).

### Command PATH resolution (env.rs)

Release builds launched from a desktop shell (Finder/Dock) inherit a
minimal PATH missing Homebrew, Nix profiles, and cargo bins. `env.rs`
centralizes lookup so every Rust IPC command (git, gh, bun, nix, …)
resolves tools the same way, augmenting PATH with `COMMON_TOOL_DIRS`
(`/run/current-system/sw/bin`, `/nix/var/nix/profiles/default/bin`,
`/opt/homebrew/bin`, …). Resolve external binaries through this helper,
not bare `Command::new("git")`.

## Agent runtime env

Tauri sets these when spawning `agent/main.ts`:

| Env var               | Purpose                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `AETHON_DOCS_DIR`     | Bundled docs (`docs/aethon-agent/`) — system prompt points the model here.                |
| `AETHON_USER_DIR`     | `~/.aethon/` — extensions, sessions, state file.                                  |
| `AETHON_STATE_FILE`   | `~/.aethon/state.json` snapshot, debounced 200 ms.                                        |
| `AETHON_SESSIONS_DIR` | `~/.aethon/sessions/<tabId>/` — pi `SessionManager.continueRecent` per tab.               |
| `AETHON_RELEASE_MODE` | `"1"`/`"0"`. System prompt branches on this to avoid pointing at source paths in release. |
| `AETHON_PROJECT_ROOT` | Source tree path in dev only.                                                             |

`agent/system-prompt.ts` composes the static template from
`agent/system-prompt/prompt-template.ts` → optional
`~/.aethon/system-prompt.md` override → optional
`~/.aethon/system-prompt-append.md` → runtime snapshot from
`getRuntimeSnapshot()` using the contract in
`agent/system-prompt/types.ts`. Snapshot rebuilds on every
`resourceLoader.reload()`; extensions load **before** the default tab so its
session prompt sees them.

## Logging

Levels via `AETHON_LOG` (preferred) or `RUST_LOG` / `LOG_LEVEL`. Defaults
`info` in dev, `warn` in release. The Rust subscriber uses
`tracing-subscriber::EnvFilter` so target scopes work
(`AETHON_LOG=aethon::agent_watch=debug,aethon::config=warn`).

Two sinks: stderr (live) and `~/.aethon/logs/` (daily-rotating, 7-day
retention). Two file series share that directory:

- `aethon.YYYY-MM-DD` — Rust (`tracing`)
- `bridge.YYYY-MM-DD.log` — bun (`agent/logger.ts`)

## Driving the app from Claude

`.claude/skills/aethon-debug/` is slash-commandable. In debug builds the
Rust shell starts a TCP eval server on `127.0.0.1:19433` (override with
`AETHON_DEBUG_PORT`); `scripts/debug-eval.sh` ships JS to it, which
wraps in an async IIFE and evals inside the webview. Use proactively
after touching UI or agent code.

Dev-only webview globals:

- `window.__AETHON_STATE__()`, `window.__AETHON_SET_STATE__(next)`
- `window.__AETHON_INVOKE__` (Tauri `invoke`)
- `window.__AETHON_EXTENSION_REGISTRY__` (`ExtensionRegistry`)
- `window.aethon` (public runtime API)

The dev build must already be running — never launch a release build
(debug server gated by `cfg(debug_assertions)`).

## Conventions

- **Conventional Commits** for all messages: `feat(scope):`, `fix(scope):`.
- **TypeScript strict + `verbatimModuleSyntax` + `erasableSyntaxOnly`.**
  Use `import type { ... }` for type-only imports.
- **No global state in the Rust shell** beyond Tauri's `Manager`
  (currently just the `AgentProcess` mutex).
- **No emojis in code or commits** unless asked.
- A few `react-hooks/*` per-line disables exist for set-state-in-effect
  resync paths + intentionally-empty memo deps. Audit on touch; don't
  broaden.

## Adding a Tauri plugin

1. `cargo add tauri-plugin-X --manifest-path src-tauri/Cargo.toml`
2. Register in `src-tauri/src/lib.rs` via `.plugin(tauri_plugin_X::init())`
3. Add permissions to `src-tauri/capabilities/default.json`

## Nix / Linux build notes

`flake.nix` carries platform-specific workarounds — read it before
changing the toolchain or build inputs.

- Linux needs `webkit2gtk_4_1` + GTK closure on `PKG_CONFIG_PATH` (set
  manually because numtide/devshell skips pkg-config setup hooks).
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` dodges a Mesa/Wayland crash.
- macOS pins both `CC=/usr/bin/cc` _and_
  `CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/cc`. The first
  steers `cc-rs` build scripts to Apple's toolchain; the second
  overrides what rustc invokes at the link step. Without the linker
  pin, rustc resolves bare `cc` through PATH and lands on
  `/run/current-system/sw/bin/cc` — nix-darwin's wrapped GCC pointing
  at Nix's bundled `apple-sdk-14.4`. That SDK's `libSystem.tbd` is
  missing dozens of POSIX symbols (`_write`, `_waitpid`,
  `__NSGetEnviron`, …) and ld errors out with "Undefined symbols for
  architecture arm64". Pinning to `/usr/bin/cc` keeps the link against
  the active Xcode SDK and produces a binary whose load commands
  reference `/usr/lib/libiconv.2.dylib` (and the other canonical
  Apple paths) — installable on any Mac. **Do not** re-add
  `pkgs.libiconv` to `darwinBuildInputs` or point `LIBRARY_PATH` /
  `NIX_LDFLAGS` at it; that bakes a `/nix/store` install_name into
  the bundle, and dyld rejects it on any non-builder Mac for a Team
  ID mismatch with our notarized signature.
- `build-app` runs `scripts/verify-bundle.sh` after `cargo tauri build`
  as a fail-loud safety net: it greps `otool -L` on the bundled binary
  for `/nix/store` and aborts before the bundle can ship. The wrapper
  also tolerates Tauri's tail-end non-zero exit when
  `TAURI_SIGNING_PRIVATE_KEY` is unset (the .app has already been
  written by then) so unsigned local builds still get verified.
