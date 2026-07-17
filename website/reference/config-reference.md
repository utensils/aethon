# `config.toml` reference

This is the exhaustive schema for `~/.aethon/config.toml`. The
[Configuration guide](/guide/configuration) walks through the common
fields with copy-paste examples; this page is the keys-and-defaults
table for when you need to look up an option.

The file lives at `~/.aethon/config.toml` (resolved through Tauri's
cross-platform home-directory API). Every section is optional, and so is
every key inside it. Unset values use the defaults documented below.

Aethon never crashes on a malformed `config.toml`. A few rules govern
how it tolerates bad input:

- **Parse errors** fall back to the full set of defaults; the error is
  logged, not surfaced as a crash.
- **Unknown enum values** (a misspelled `theme`, `enabled`, `mode`, …)
  fall back to a safe default per field rather than erroring.
- **Out-of-range numbers** clamp to the nearest valid value. This is
  non-fatal but not always silent: `ui.font_size`, for example, logs a
  warning when it clamps.
- **Unknown sections and keys** are preserved on round-trip; Aethon only
  writes back the keys it manages.
- **File size**: Aethon reads at most the first 64 KiB of the file. Any
  bytes past that are ignored, so truncating mid-file may produce a parse
  error that falls back to defaults.

## `[ui]`

```toml
[ui]
theme = "ember"
font_size = 14
restore_tabs = false                 # deprecated / no-op compatibility field
notify_on_completion = true
notify_min_duration_seconds = 8
thinking_visibility = "hide"         # default when unset: hide
tool_calls_visibility = "hide"       # default when unset: hide
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `theme` | string | `"ember"` | One of the registered theme ids. Built-ins: `ember`, `paper`, `aether`, `brink`, `daylight`, `mist`, `nocturne`. `signature` is a back-compat alias for `aether`. Custom theme ids registered by extensions are valid here too. Unknown ids fall back to `ember`. |
| `font_size` | integer | `14` | Terminal and editor font size in pixels. Clamped to 10-24; values outside that range are clamped (with a warning logged) to protect layout integrity. |
| `restore_tabs` | boolean | `false` | **Deprecated / no-op compatibility field.** Parsed and round-tripped through Settings for older configs, but no runtime code consumes it — tab and session restoration currently happens per workspace regardless. The effective default is `false`. |
| `notify_on_completion` | boolean | `true` | Notify when an agent turn ends and you are not watching that tab: an in-app toast if the Aethon window is focused but another tab is active, or a native OS notification if the window is unfocused. Nothing fires if the finishing tab is already active. |
| `notify_min_duration_seconds` | integer | `8` | Minimum turn length (seconds) to trigger the completion notification. Sub-second turns skip notification. Clamped to 0-3600. |
| `thinking_visibility` | `"show" \| "collapse" \| "hide"` | `"hide"` | Global default visibility for the model's thinking blocks in the transcript. The unset default is `"hide"` (clean transcript); an *unknown explicit* value falls back to `"show"` so a typo can't silently hide content. Per-tab overridable at runtime via the composer visibility pills. |
| `tool_calls_visibility` | `"show" \| "group-turn" \| "group-run" \| "group-block" \| "hide"` | `"hide"` | Global default visibility and grouping for tool-call cards. The unset default is `"hide"`; an *unknown explicit* value falls back to `"show"`. The legacy value `collapse` migrates to `group-turn`. Per-tab overridable at runtime via the composer visibility pills. |

## `[agent]`

```toml
[agent]
model = "anthropic/claude-sonnet-4-6"
# thinking_level = "medium"          # optional; omit to leave the model default
# codex_fast_mode = false
# provider_timeout_seconds = 120     # optional; omit to keep pi's default
bash_timeout_floor_seconds = 300
subagent_timeout_seconds = 300
idle_retire_minutes = 15
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `model` | string | provider default | The default model for new agent tabs. Format depends on the provider: `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`, etc. The `/model` slash command updates *the active tab's* model and persists the choice for new tabs. |
| `thinking_level` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra"` | unset | Default reasoning effort for new agent sessions on models that expose it. Options are model-specific: GPT-5.6 Sol/Terra support through Ultra, Luna through Max, and older models retain their existing sets. Unknown values are ignored (treated as unset). Per-session overridable via the model-picker reasoning selector. |
| `codex_fast_mode` | boolean | `false` | Request Codex Fast mode (priority service tier) for supported `openai-codex` models. Wired through `AETHON_CODEX_FAST_MODE`. |
| `provider_timeout_seconds` | integer | unset | Aethon-owned override for the provider/SDK request timeout, in seconds. Omit (or set `0`) to leave pi's own `retry.provider.timeoutMs` behavior unchanged. Clamped to 1-86400. Wired through `AETHON_PROVIDER_TIMEOUT_SECONDS`. |
| `bash_timeout_floor_seconds` | integer | `300` | Floor applied to model-supplied bash tool timeouts, in seconds. A missing or invalid (`0`) value uses the historical 5-minute default. Clamped to 1-86400. Wired through `AETHON_BASH_TIMEOUT_FLOOR_SECONDS`. |
| `subagent_timeout_seconds` | integer | `300` | Default inline subagent wall-clock ceiling, in seconds. Individual subagent frontmatter may override this per invocation (see [Agents](/guide/agents)). A missing or invalid (`0`) value uses the 5-minute default. Clamped to 1-86400. Wired through `AETHON_SUBAGENT_TIMEOUT_SECONDS`. |
| `idle_retire_minutes` | integer | `15` | Minutes a per-tab agent worker may sit idle (no prompt in flight, no traffic) before the background sweep retires it. The worker respawns lazily from the persisted session on the next message. `0` disables retirement. Clamped to 0-1440. |

::: tip
`provider_timeout_seconds` is the one `[agent]` knob with no default. Leave
it out unless a provider is timing out on legitimately long turns. The
other three timeout/idle knobs ship with working defaults.
:::

## `[shell]`

```toml
[shell]
default_share_mode = "private"
auto_restart_agent = true
default_command = ""
default_args = []
inherit_env = true
prompt_before_close = true
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `default_share_mode` | `"private" \| "read" \| "read-write" \| "read-write-trusted"` | `"private"` | Initial share mode for new shell tabs. Anything else falls back to `"private"` so a typo cannot accidentally widen exposure. |
| `auto_restart_agent` | boolean | `true` | When the bun bridge child crashes unexpectedly, automatically respawn it. Set `false` to surface the crash notice without auto-restart (useful when debugging the bridge). |
| `default_command` | string | `""` (= `$SHELL`) | Override the program spawned for new shell tabs. Empty string or omission falls back to `$SHELL` (and the platform default on macOS). |
| `default_args` | `string[]` | `[]` | Extra argv for the spawned shell. Each element becomes a separate argv slot, appended after the platform default (e.g. `-il` on Unix). Use to pass profile flags or a `-c <command>` every new tab should run. |
| `inherit_env` | boolean | `true` | Whether new shell tabs inherit Aethon's environment (`PATH`, locale, etc.). Set `false` for hermetic shells (the PTY still gets `TERM=xterm-256color`). |
| `prompt_before_close` | boolean | `true` | When closing a shell whose foreground job is *not* the shell itself (vim, npm test, ssh), prompt before killing. Enforced **frontend-side**: both `Cmd+W` and the X close button honour it. |

## `[shortcuts]`

```toml
[shortcuts]
new_tab_kind = "agent"
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `new_tab_kind` | `"agent" \| "shell"` | `"agent"` | **Deprecated compatibility key.** Parsed and round-tripped for older configs, but no longer affects `Cmd+T` — that shortcut is now strictly focus-aware (agent tab when focus is outside the bottom panel, shell sub-tab when inside) and ignores this key. Unknown values fall back to `"agent"`. |

## `[voice]`

```toml
[voice]
toggle_hotkey = "mod+shift+m"
# hold_hotkey = "AltRight" # macOS default; unset elsewhere.
speak_agent_replies = false
speak_max_chars = 600
conversation_continuous = false
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `toggle_hotkey` | string | `"mod+shift+m"` | Global hotkey to toggle voice input on and off. `mod` maps to Cmd on macOS and Ctrl on Linux/Windows. |
| `hold_hotkey` | string or unset | `"AltRight"` on macOS, unset elsewhere | Optional hold-to-record physical key. Platform-dependent default (AltRight / Option on macOS only). |
| `speak_agent_replies` | boolean | `false` | Speak the agent's reply aloud (via the LFM2-Audio provider's text-to-speech) when a turn completes on the active tab. |
| `speak_max_chars` | integer | `600` | Maximum characters of a reply to speak aloud. |
| `conversation_continuous` | boolean | `false` | Hands-free auto-listen: after a spoken reply, automatically re-open the mic for the next turn. Opt-in (push-to-talk drives each turn by default). |

::: warning
All `[voice]` behavior requires the `voice` build feature. On a build
without it, the voice commands return the error `voice support not built
into this binary` and these keys are inert. See
[Voice-to-text input](/guide/configuration#enable-or-tune-voice-input).
:::

## `[extensions]`

```toml
[extensions]
state_warn_kb = 64
state_hard_kb = 512
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `state_warn_kb` | integer | `64` | Soft warning threshold (KB) for an extension's `setState` payload. Above this, the bridge logs a WARN naming the extension and the path. Clamped to 1-8192. Wired through `AETHON_STATE_WARN_KB`. |
| `state_hard_kb` | integer | `512` | Hard rejection threshold (KB) for an extension's `setState` payload. Above this the write is rejected and the extension's mutation Promise resolves to `{ ok: false, error }`. Clamped to 1-8192 and raised to at least `state_warn_kb`. Wired through `AETHON_STATE_HARD_KB`. |

## `[updates]`

```toml
[updates]
channel = "stable"
disable_auto_check = false
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `channel` | `"stable" \| "nightly"` | `"stable"` | Which release channel the auto-updater checks. `stable` tracks `releases/latest`; `nightly` follows the nightly tag for in-development builds. Unknown values fall back to `"stable"`. |
| `disable_auto_check` | boolean | `false` | Disable automatic background update checks entirely. The manual "Check for Updates" menu item still works. |

## `[devshell]`

Controls Nix devshell detection for shell tabs and the agent's pi `bash`
tool.

```toml
[devshell]
enabled = "auto"
mode = "auto"
cache_ttl_hours = 720
refresh_on_lockfile_change = true
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | `"auto" \| "always" \| "never"` | `"auto"` | Whether to detect and apply a Nix devshell on shell and agent spawn. `auto` detects via marker files; `always` forces detection with loud errors on failure; `never` disables wrapping entirely. Unknown values fall back to `"auto"`. |
| `mode` | `"auto" \| "direnv" \| "nix" \| "nix-shell"` | `"auto"` | Pin a resolver kind. `auto` honours natural precedence (direnv before flake before `shell.nix`). Named variants force a single kind and fall back to no-wrap if the marker file or binary is missing. |
| `cache_ttl_hours` | integer | `720` | How long a successful on-disk snapshot stays valid (hours) before the next launch ignores it. Lockfile-hash mismatches always invalidate first. `0` disables time-based eviction. |
| `refresh_on_lockfile_change` | boolean | `true` | Re-resolve automatically when watched lockfile or marker files change mtime. Disable to require a manual "Refresh now" in Settings. |

### Per-project override

A project can override the global `[devshell]` section with
`<project-root>/.aethon/devshell.toml`:

```toml
# <project-root>/.aethon/devshell.toml
[devshell]
enabled = "never"   # never wrap this repo
mode = "nix"        # if enabled, force the flake resolver
```

Merge semantics:

- Only `enabled` and `mode` are per-project-overridable. Project-level
  values take precedence when set; missing keys fall through to the global
  `[devshell]` defaults. The two keys can be overridden independently.
- `cache_ttl_hours` and `refresh_on_lockfile_change` are **global only**;
  a project file cannot change them.
- The override is loaded best-effort at command-invocation time (in
  `effective_config()`, consumed by `devshell_status`,
  `devshell_env_for_path`, and `devshell_refresh`). Malformed TOML is
  silently ignored, so a bad `.aethon/devshell.toml` never blocks a shell
  from opening.

::: tip
`[devshell]` is the only section with a per-project variant. Every other
section is global to `~/.aethon/config.toml`.
:::

## `[server]`

```toml
[server]
enabled = true
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether to start the unauthenticated LAN HTTP listener and advertise this host over mDNS (`_aethon._tcp.local.`) at boot. Set `false` to stop LAN exposure while keeping peer discovery (the browser) running read-only. A manual `server_start` action starts and advertises regardless of this flag. |

::: warning
The discovery server has **no authentication and no TLS**. It is explicit
scaffolding for an upcoming pairing feature; do not treat the HTTP
endpoints as a trusted IPC channel. `enabled = false` prevents the local
HTTP listener and mDNS advertiser from starting on boot; the read-only
discovery browser keeps running.
:::

## `[startup]`

```toml
[startup]
auto_approve = false
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `auto_approve` | boolean | `false` | Globally trust configured per-project workspace startup commands. Default `false` because project startup commands are an execution boundary and should stay visible until you explicitly opt in. Per-project startup commands live in `.aethon/startup.toml`. |

## `[mcp]`

```toml
[mcp]
enabled = true
project_configs = "require-approval"
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable Model Context Protocol (MCP) support at the host level. With it on, installing a project MCP config plus explicit approval is sufficient to load servers. |
| `project_configs` | `"auto-load" \| "require-approval" \| "never"` | `"require-approval"` | How Aethon handles repo-owned MCP config files (`.aethon/mcp.toml`, `.mcp.json`). `auto-load` (aliases `always` / `auto_load`) loads them automatically; `require-approval` prompts first (default); `never` (alias `disabled`) ignores them. See the `/mcp` and `/mcp-auth` slash commands. |

## `[guardrails]`

```toml
[guardrails]
# soft_prompt_anchor = "Prefer small, reviewable diffs. Run the test suite before claiming done."
hard_enforce_project_root = false
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `soft_prompt_anchor` | string | unset | Optional free-text "soft anchor" appended to the per-turn working context the agent injects into the model's system prompt. Use it to remind the model of project rules. Whitespace-only is treated as unset. This **never enforces anything**: it is advisory prompt text only. Wired through `AETHON_SOFT_GUARDRAIL_PROMPT` (emitted only when present). |
| `hard_enforce_project_root` | boolean | `false` | Hard enforcement: blocks write/edit/bash tool calls touching paths outside the active tab's project root. A deterministic backstop for a wandering model. The per-tab composer toggle can override this default per session. Wired through `AETHON_HARD_ENFORCE_PROJECT_ROOT` (`0` or `1`). |

::: tip
`soft_prompt_anchor` is advice; `hard_enforce_project_root` is a hard
deny. Pair them: a short anchor steers the model, and the enforcement flag
is the backstop if it wanders anyway.
:::

## Clamps and validation

Out-of-range numbers clamp to the nearest valid value (non-fatal, though
some keys like `ui.font_size` log a warning when they clamp); unknown enum
values fall back to safe defaults. Aethon corrects the value rather than
erroring.

| Key | Range | Zero handling |
|---|---|---|
| `ui.font_size` | 10-24 | clamps into range |
| `ui.notify_min_duration_seconds` | 0-3600 | `0` allowed (notify on any turn) |
| `agent.provider_timeout_seconds` | 1-86400 | `0` / unset means "leave pi's default" |
| `agent.bash_timeout_floor_seconds` | 1-86400 | `0` falls back to default `300` |
| `agent.subagent_timeout_seconds` | 1-86400 | `0` falls back to default `300` |
| `agent.idle_retire_minutes` | 0-1440 | `0` disables retirement |
| `extensions.state_warn_kb` | 1-8192 | clamps into range |
| `extensions.state_hard_kb` | 1-8192 | raised to at least `state_warn_kb` |
| `devshell.cache_ttl_hours` | 0 and up | `0` disables time-based eviction |

Enum fall-backs: `theme` to `ember`, `default_share_mode` to `private`,
`new_tab_kind` to `agent`, `updates.channel` to `stable`,
`devshell.enabled` / `devshell.mode` to `auto`,
`mcp.project_configs` to `require-approval`. `agent.thinking_level` is
enum-validated too — an unknown value is treated as unset, not clamped.

`voice.speak_max_chars` has no clamp; it is used as written.

## Environment variable wiring

Some config keys are pushed into the agent bridge process as `AETHON_*`
environment variables at spawn time (in
`agent_process/spawn.rs::apply_user_env()`). Editing one of these keys takes
effect on the **next agent spawn**, not the next render.

| Config key | Env var | Effect |
|---|---|---|
| `agent.codex_fast_mode` | `AETHON_CODEX_FAST_MODE` | Codex Fast (priority service tier) request flag (emitted `0` / `1`). |
| `agent.provider_timeout_seconds` | `AETHON_PROVIDER_TIMEOUT_SECONDS` | Provider/SDK request timeout (omitted when unset/`0`). |
| `agent.bash_timeout_floor_seconds` | `AETHON_BASH_TIMEOUT_FLOOR_SECONDS` | Floor for bash tool timeouts. |
| `agent.subagent_timeout_seconds` | `AETHON_SUBAGENT_TIMEOUT_SECONDS` | Default inline subagent ceiling. |
| `extensions.state_warn_kb` | `AETHON_STATE_WARN_KB` | Soft `setState` payload warning threshold. |
| `extensions.state_hard_kb` | `AETHON_STATE_HARD_KB` | Hard `setState` payload rejection threshold. |
| `guardrails.soft_prompt_anchor` | `AETHON_SOFT_GUARDRAIL_PROMPT` | Advisory system-prompt anchor (emitted only when present). |
| `guardrails.hard_enforce_project_root` | `AETHON_HARD_ENFORCE_PROJECT_ROOT` | `1` to enforce the project-root write/edit/bash deny. |

::: tip
Provider credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are **not**
Aethon config. They come from the shell environment Aethon was launched
with and are read by pi. See [Models and providers](/guide/agents#models-and-providers)
and the [Runtime API](/reference/runtime-api) page for the full non-config
`AETHON_*` runtime contract.
:::

## How Aethon reads and writes the file

- **Reads** happen at app launch and again whenever the Settings panel is
  opened. Manual edits take effect on next launch (or next Settings open).
- **Writes** happen when you change a value in Settings and the panel
  saves. Aethon uses `toml_edit`, so it preserves comments, key ordering,
  and any custom keys or unknown sections you added by hand. Only the
  whitelisted keys the Settings UI manages are written back.
- **Reset to defaults** in Settings clears the keys Aethon manages but
  leaves the file intact, including your custom keys.
- **File size**: Aethon reads at most the first 64 KiB and parses what it
  read. A file whose first 64 KiB is valid TOML still loads; truncating
  mid-file may cause a parse error that falls back to defaults.

## Where to next

- [Configuration](/guide/configuration): task-focused tour with full
  copy-paste blocks.
- [Agents](/guide/agents): models, providers, subagents, and the timeout
  precedence that `[agent]` feeds.
- [Themes](/guide/themes): registering custom themes that `[ui] theme`
  can target.
- [Settings & search](/guide/settings-and-search): the GUI for
  `config.toml`.
