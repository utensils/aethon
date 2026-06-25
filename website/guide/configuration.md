# Configuration

Aethon stores user settings in **`~/.aethon/config.toml`**. The Settings
panel (`Cmd+,`) writes the same file: power users can edit it directly, or
click **Open config.toml** in Settings to reveal it in your editor.

This page is task-focused. Each section below is a copy-paste block for a
common setup. The full keys-and-defaults schema lives in
[`reference/config-reference`](/reference/config-reference).

## File layout

```toml
# ~/.aethon/config.toml (managed by Aethon Settings).

[ui]
theme = "ember"
font_size = 14
notify_on_completion = true
notify_min_duration_seconds = 8
thinking_visibility = "hide"
tool_calls_visibility = "hide"

[agent]
model = "anthropic/claude-sonnet-4-6"
# provider_timeout_seconds = 120   # optional; omit to keep pi's default
bash_timeout_floor_seconds = 300
subagent_timeout_seconds = 300
idle_retire_minutes = 15
# thinking_level = "medium"        # off|minimal|low|medium|high|xhigh; unset = provider default
codex_fast_mode = false

[shell]
default_share_mode = "private"
auto_restart_agent = true
default_command = ""              # empty = $SHELL
default_args = []
inherit_env = true
prompt_before_close = true

[voice]
toggle_hotkey = "mod+shift+m"
# hold_hotkey defaults to "AltRight" on macOS and unset elsewhere.
speak_agent_replies = false
speak_max_chars = 600
conversation_continuous = false

[mcp]
enabled = true
project_configs = "require-approval"  # auto-load | require-approval | never

[startup]
auto_approve = false

[extensions]
state_warn_kb = 64
state_hard_kb = 512

[updates]
channel = "stable"
disable_auto_check = false

[devshell]
enabled = "auto"
mode = "auto"
cache_ttl_hours = 720
refresh_on_lockfile_change = true

[server]
enabled = true

[guardrails]
# soft_prompt_anchor = "Prefer small, reviewable diffs."
hard_enforce_project_root = false
```

Every section is optional, and so is every key. Unset values use the
defaults shown above. Aethon never crashes on a bad TOML file: it logs a
parse error and falls back to defaults, clamps out-of-range numbers, and
falls back unknown enum values to safe defaults.

## The `.aethon` directory

`~/.aethon/` holds everything Aethon persists per user:

```text
~/.aethon/
├── config.toml            # this file
├── agents/                # user-scope subagent definitions (<name>.md)
├── extensions/            # installed extension packages
├── sessions/<tabId>/      # one pi session per agent tab
├── auth/                  # auth-profile metadata + per-profile credentials
├── logs/                  # daily-rotating Rust + bridge logs
├── state.json             # tab / layout snapshot
├── window-state.json      # window geometry restore
├── system-prompt.md       # optional full system-prompt override
├── system-prompt-append.md# optional system-prompt append
├── devshell-cache/        # resolved Nix devshell snapshots
├── updates/               # update backups for boot-probation rollback
└── projects.json          # recent project list
```

The hand-editable ones are `config.toml`, the subagent definitions under
`agents/` (see [Agents](/guide/agents#subagents)), and the system-prompt
override / append files (see
[Agents](/guide/agents#system-prompt-customization)). The rest are managed
by Aethon.

## Set a theme

```toml
[ui]
theme = "nocturne"
```

Built-ins: `ember`, `paper`, `aether`, `brink`, `daylight`, `mist`,
`nocturne` (plus `signature`, a back-compat alias for `aether`). An
extension can register more; any registered id is valid here. An unknown
id falls back to `ember`. You can also switch live with `/theme nocturne`.
See [Themes](/guide/themes) for registering custom themes.

`font_size` is the terminal and editor size in pixels, clamped to 10-24:

```toml
[ui]
font_size = 16
```

## Tune transcript density

Hide or group the model's thinking blocks and tool-call cards by default:

```toml
[ui]
thinking_visibility = "collapse"      # show | collapse | hide
tool_calls_visibility = "group-turn"  # show | group-turn | group-run | group-block | hide
```

Both default to `hide` when unset, so a fresh install opens with a clean
transcript. Both are per-tab overridable at runtime via the composer
visibility pills; these keys only set the global default for new tabs. The
full grouping enum is in the [config reference](/reference/config-reference#ui).

## Set a default model for new tabs

```toml
[agent]
model = "anthropic/claude-sonnet-4-6"
```

The format is `provider/model-id` (`anthropic/claude-sonnet-4-6`,
`openai/gpt-4o`, `ollama/llama3.3`). This is the model new tabs open with;
`/model` changes the active tab and persists the choice. Provider
credentials come from the shell environment, not this file. See
[Models and providers](/guide/agents#models-and-providers).

## Tune agent and provider timeouts

The `[agent]` timeout knobs give long-running work more headroom. All are
in seconds and apply on the **next agent spawn**.

```toml
[agent]
# Only set this if a provider times out on legitimately long turns.
provider_timeout_seconds = 300   # omit entirely to keep pi's own default

# Raise the floor under model-supplied bash timeouts (default 300 = 5 min).
bash_timeout_floor_seconds = 600

# Default ceiling for inline subagents (default 300). Subagent frontmatter
# can override this per invocation.
subagent_timeout_seconds = 900
```

`subagent_timeout_seconds` is the floor of a precedence chain: a
subagent's frontmatter `timeout` wins, then `AETHON_SUBAGENT_TIMEOUT_SECONDS`,
then this key, then the built-in 300. See
[Agents](/guide/agents#subagents) for the full precedence and frontmatter.

## Keep agent workers warm (or reclaim memory)

```toml
[agent]
# Retire an idle per-tab worker after 30 minutes instead of the default 15.
idle_retire_minutes = 30

# Or never retire (workers stay resident; faster follow-ups, more memory):
# idle_retire_minutes = 0
```

A retired worker respawns lazily from its persisted session on the next
message. `0` disables retirement entirely (clamped 0-1440).

## Quieter completion notifications

```toml
[ui]
notify_on_completion = true
notify_min_duration_seconds = 30   # only ping for turns 30s or longer
```

Set `notify_on_completion = false` to silence completion alerts, or raise
`notify_min_duration_seconds` (0-3600) so only genuinely long turns
interrupt you. When a turn ends, Aethon shows an in-app toast if the window
is focused but you are on a different tab, and a native OS notification if
the window is unfocused. Nothing fires if the finishing tab is already
active.

## Hermetic shells

```toml
[shell]
default_command = "/bin/zsh"
default_args = ["-l"]
inherit_env = false   # do not leak Aethon's PATH/locale into shell tabs
```

With `inherit_env = false`, new shell tabs start without Aethon's
environment (the PTY still gets `TERM=xterm-256color`). `default_command`
overrides the spawned program; empty or omitted falls back to `$SHELL`.
`default_args` are appended after the platform default. See
[Shells & share modes](/guide/shells-and-share-modes) for share-mode
semantics.

## Tab shortcuts (`Cmd+T` is focus-aware)

`Cmd+T` is **strictly focus-aware** and is not configurable: it opens an
agent tab when focus is outside the bottom terminal panel, and a shell
sub-tab when focus is inside it. `Cmd+Shift+T` always opens a shell
sub-tab. See [Agent tabs](/guide/agent-tabs) and
[Shells & share modes](/guide/shells-and-share-modes).

::: warning Deprecated
`[shortcuts] new_tab_kind` is a vestigial no-op. It is still parsed for
back-compat but has no runtime effect — nothing reads it. Remove it from
your config; the focus-aware routing above is the only behavior.
:::

## Set the default reasoning effort

```toml
[agent]
thinking_level = "medium"   # off | minimal | low | medium | high | xhigh
codex_fast_mode = false     # Codex models: trade reasoning depth for speed
```

`thinking_level` is the default reasoning effort for new tabs; leave it
unset to use each provider's own default. A tab can override it per session
from the model picker's reasoning selector (see
[Agents](/guide/agents#reasoning-effort)). `codex_fast_mode` only affects
Codex-family models.

## Enable or tune the Nix devshell wrap

Aethon can auto-detect a project's Nix devshell (direnv, flake, or
`shell.nix`) and apply its environment to both interactive shell tabs and
the agent's pi `bash` tool.

```toml
[devshell]
enabled = "auto"   # auto | always | never
mode = "auto"      # auto | direnv | nix | nix-shell
cache_ttl_hours = 720
refresh_on_lockfile_change = true
```

- `enabled = "never"` disables wrapping globally.
- `enabled = "always"` forces detection and fails loud if a marker resolves
  but the resolver errors.
- `mode` pins a single resolver kind; `auto` follows precedence (direnv,
  then flake, then `shell.nix`).

To pin or disable per project, drop a `devshell.toml` in the repo:

```toml
# <project-root>/.aethon/devshell.toml
[devshell]
enabled = "never"   # never wrap this repo
# mode = "nix"      # or pin the flake resolver if enabled
```

Only `enabled` and `mode` are per-project-overridable; `cache_ttl_hours`
and `refresh_on_lockfile_change` stay global.

::: warning
A malformed per-project `devshell.toml` is silently ignored, so a typo
never blocks a shell from opening. It also means a typo is silently
ineffective: confirm the override took with the `⬡` status-bar chip or
`AETHON_LOG=aethon::devshell=debug`.
:::

## Track nightly builds

```toml
[updates]
channel = "nightly"   # stable | nightly
disable_auto_check = false
```

`stable` tracks the latest release; `nightly` follows the nightly tag for
in-development builds. Set `disable_auto_check = true` to stop background
checks; the manual "Check for Updates" menu item still works.

## Stop LAN advertisement

```toml
[server]
enabled = false
```

This silences the mDNS advertiser (`_aethon._tcp.local.`) so other hosts
stop discovering this one. Read-only peer discovery still runs, and a
manual `server_start` action advertises regardless.

::: warning
The discovery server has no authentication and no TLS today. It is
scaffolding for an upcoming pairing feature, not a trusted IPC channel.
:::

## Team guardrails

```toml
[guardrails]
# Advisory: appended to the model's working context every turn. Steers, never blocks.
soft_prompt_anchor = "Prefer small, reviewable diffs. Run the test suite before claiming done."

# Enforcing: blocks write/edit/bash tool calls outside the active tab's project root.
hard_enforce_project_root = true
```

`soft_prompt_anchor` is advice the model can ignore; `hard_enforce_project_root`
is a deterministic deny that the per-tab composer toggle can override per
session. Pair them: the anchor steers the model, the enforcement flag is
the backstop. Both apply on the next agent spawn.

## Enable or tune voice input

```toml
[voice]
toggle_hotkey = "mod+shift+m"   # mod = Cmd on macOS, Ctrl elsewhere
# hold_hotkey = "AltRight"      # optional push-to-talk physical key
speak_agent_replies = false     # read agent replies aloud (LFM2-Audio TTS)
speak_max_chars = 600           # cap spoken reply length, in characters
conversation_continuous = false # hands-free: auto-listen after each spoken reply
```

`mod` maps to Cmd on macOS and Ctrl on Linux/Windows. `hold_hotkey` is an
optional hold-to-record key (default `AltRight` / Option on macOS only).

The last three keys drive the LFM2-Audio speak-aloud / hands-free
conversation mode: `speak_agent_replies` reads replies back to you,
`speak_max_chars` caps how much of a long reply is spoken, and
`conversation_continuous` re-arms the mic after each reply for a hands-free
loop. Auto-listen is also a runtime toggle in the conversation HUD (off by
default). Push-to-talk is `Cmd+Shift+M` (the `toggle_hotkey` above); the
optional `hold_hotkey` is a press-and-hold-to-record physical key.

::: warning
Voice requires the `voice` build feature. On a build without it these keys
are inert and the voice commands return the error `voice support not built
into this binary`.
:::

## MCP servers

Aethon can connect to [Model Context Protocol](https://modelcontextprotocol.io)
servers and expose their tools to the agent.

```toml
[mcp]
enabled = true                        # host-level MCP support
project_configs = "require-approval"  # auto-load | require-approval | never
```

`enabled` turns MCP support on or off at the host level. `project_configs`
is the trust policy for repo-owned MCP files (`<project>/.aethon/mcp.toml`
or `.mcp.json`):

- `require-approval` (default) — load repo MCP files only after you approve them.
- `auto-load` — trust and load repo MCP files automatically.
- `never` — ignore repo MCP files entirely.

Use `/mcp status` to inspect connections, `/mcp setup` to add a server, and
`/mcp-auth [server]` to run a server's auth flow. See
[Slash commands](/reference/slash-commands).

## Workspace startup commands

A workspace can declare startup commands that run when it becomes active,
defined per project in `<project>/.aethon/startup.toml`. The host gate
controls whether those commands run without a prompt:

```toml
[startup]
auto_approve = false   # true = run workspace startup commands without confirming
```

Leave `auto_approve = false` to be asked before a workspace's startup
commands run; set it to `true` to trust them globally.

## Per-project configuration

Only `[devshell]` supports a per-project override of a `config.toml`
section, via `<project-root>/.aethon/devshell.toml` (see
[the devshell section above](#enable-or-tune-the-nix-devshell-wrap)).
Every other section is global to `~/.aethon/config.toml`; there is no
per-project variant for `[ui]`, `[agent]`, `[shell]`, and the rest.

Separately, a repo can ship its own definitions in `.aethon/`:
`mcp.toml` / `.mcp.json` (MCP servers, gated by `[mcp] project_configs`)
and `startup.toml` (workspace startup commands, gated by `[startup]
auto_approve`). Those are repo-owned files, not `config.toml` overrides.

## Hot-reload

Most fields take effect on the next render. A few need a spawn or restart:

- **Immediate** (next render): `theme`, `font_size`,
  `thinking_visibility`, `tool_calls_visibility`.
- **New shell tabs only**: `default_share_mode`, `default_command`,
  `default_args`, `inherit_env`, `prompt_before_close`.
- **Next agent spawn** (env-wired): the `[agent]` timeout/idle keys and
  the `[guardrails]` keys flow through `apply_user_env`, so they apply when
  the worker next starts.
- **Next launch**: `auto_restart_agent`, `[server] enabled`.
- **Devshell refresh / next spawn**: `[devshell]` fields, plus the
  explicit "Refresh now" button in Settings.

## Where to next

- [Reference: config.toml](/reference/config-reference): exhaustive
  schema, clamp ranges, and environment-variable wiring.
- [Agents](/guide/agents): models, providers, subagent timeouts, and
  system-prompt overrides.
- [Themes](/guide/themes): registering custom themes.
- [Extensions](/guide/extensions): extending Aethon.
