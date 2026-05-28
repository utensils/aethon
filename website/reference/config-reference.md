# `config.toml` reference

This is the exhaustive schema for `~/.aethon/config.toml`. The
[Configuration guide](/guide/configuration) walks through the common
fields with examples; this page is the keys-and-defaults table for when
you need to look up an option.

Aethon never crashes on a malformed `config.toml` — it logs the parse
error and falls back to defaults. Unknown sections and keys are
preserved; Aethon only writes back the keys it manages.

## `[ui]`

```toml
[ui]
theme = "ember"
font_size = 14
restore_tabs = true
notify_on_completion = true
notify_min_duration_seconds = 8
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `theme` | string | `"ember"` | One of the registered theme ids. Built-ins: `ember`, `paper`, `aether`, `brink`, `daylight`, `mist`, `nocturne`. `signature` is a back-compat alias for `aether`. Unknown ids fall back to `ember`. |
| `font_size` | integer | `14` | Clamped to a sensible range (10–22). |
| `restore_tabs` | boolean | `true` | Re-open all tabs from the previous session on launch. |
| `notify_on_completion` | boolean | `true` | Fire a native OS notification when a turn ends and the originating tab or window is unfocused. |
| `notify_min_duration_seconds` | integer | `8` | Minimum turn length (s) for the completion notification. Sub-second turns rarely need a notification. |

## `[agent]`

```toml
[agent]
model = "anthropic/claude-sonnet-4-6"
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `model` | string | provider default | The default model for new agent tabs. Format depends on the provider — `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`, etc. The `/model` slash command updates *the active tab's* model and persists the choice for new tabs. |

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
| `default_command` | string | `""` (= `$SHELL`) | Override the program spawned for new shell tabs. Empty string or omission falls back to `$SHELL` (and the platform default). |
| `default_args` | `string[]` | `[]` | Extra argv for the spawned shell. Appended after the platform default (e.g. `-il` on Unix). |
| `inherit_env` | boolean | `true` | Whether new shell tabs inherit Aethon's environment (`PATH`, locale, etc.). Set `false` for hermetic shells (the PTY still gets `TERM=xterm-256color`). |
| `prompt_before_close` | boolean | `true` | When closing a shell whose foreground job is *not* the shell itself (vim, npm test, ssh), prompt before killing. `Cmd+W` honours this; the X close button always honours it. |

## `[shortcuts]`

```toml
[shortcuts]
new_tab_kind = "agent"
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `new_tab_kind` | `"agent" \| "shell"` | `"agent"` | What `Cmd+T` opens when focus is *outside* the bottom terminal panel. `"agent"` keeps the focus-aware default; `"shell"` makes `Cmd+T` always open a shell sub-tab. Anything else falls back to `"agent"`. |

## `[voice]`

```toml
[voice]
toggle_hotkey = "mod+shift+m"
# hold_hotkey = "AltRight" # macOS default; unset elsewhere.
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `toggle_hotkey` | string | `"mod+shift+m"` | Toggle voice input. `mod` means Cmd on macOS and Ctrl elsewhere. |
| `hold_hotkey` | string or unset | `"AltRight"` on macOS, unset elsewhere | Optional hold-to-record physical key. |

## `[extensions]`

```toml
[extensions]
state_warn_kb = 64
state_hard_kb = 512
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `state_warn_kb` | integer | `64` | Soft warning threshold for extension `setState` payloads. Clamped to 1-8192 KB. |
| `state_hard_kb` | integer | `512` | Hard rejection threshold for extension `setState` payloads. Clamped to 1-8192 KB and raised to at least `state_warn_kb`. |

## `[updates]`

```toml
[updates]
channel = "stable"
disable_auto_check = false
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `channel` | `"stable" \| "nightly"` | `"stable"` | Which release channel the updater checks. Unknown values fall back to `"stable"`. |
| `disable_auto_check` | boolean | `false` | Disable automatic background checks. Manual "Check for Updates" still works. |

## `[devshell]`

```toml
[devshell]
enabled = "auto"
mode = "auto"
cache_ttl_hours = 720
refresh_on_lockfile_change = true
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | `"auto" \| "always" \| "never"` | `"auto"` | Detect and apply Nix devshells automatically, force resolution, or disable wrapping. Unknown values fall back to `"auto"`. |
| `mode` | `"auto" \| "direnv" \| "nix" \| "nix-shell"` | `"auto"` | Resolver selection. `auto` uses natural precedence: direnv, then flake, then `shell.nix`. |
| `cache_ttl_hours` | integer | `720` | Successful on-disk snapshot lifetime. `0` disables time-based eviction; lockfile-hash mismatches still invalidate. |
| `refresh_on_lockfile_change` | boolean | `true` | Re-resolve when watched lockfile or marker files change. |

## How Aethon reads and writes the file

- **Reads** happen at app launch and again whenever the Settings panel
  is opened — manual edits take effect on next launch (or next Settings open).
- **Writes** happen when you change a value in Settings and the panel
  saves. Aethon writes back **only the keys it manages**, preserving
  any custom keys you've added by hand.
- **Reset to defaults** in Settings clears the keys Aethon manages but
  leaves the file intact. Custom keys you've added are preserved.

## Where to next

- [Configuration](/guide/configuration) — guided tour with examples.
- [Themes](/guide/themes) — registering custom themes that `[ui] theme` can target.
- [Settings & search](/guide/settings-and-search) — the GUI for `config.toml`.
