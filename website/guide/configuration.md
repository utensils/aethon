# Configuration

Aethon stores user settings in **`~/.aethon/config.toml`**. The Settings
panel (`Cmd+,`) writes the same file — power-users can edit it directly,
or click **Open config.toml** in Settings to reveal it in your editor.

The full schema lives in [`reference/config-reference`](/reference/config-reference);
this page covers the common ones with examples.

## File layout

```toml
# ~/.aethon/config.toml — managed by Aethon Settings.

[ui]
theme = "ember"
font_size = 14
restore_tabs = true
notify_on_completion = true
notify_min_duration_seconds = 8

[agent]
model = "anthropic/claude-sonnet-4-6"

[shell]
default_share_mode = "private"
auto_restart_agent = true
default_command = ""              # empty = $SHELL
default_args = []
inherit_env = true
prompt_before_close = true

[shortcuts]
new_tab_kind = "agent"

[voice]
toggle_hotkey = "mod+shift+m"
# hold_hotkey defaults to "AltRight" on macOS and unset elsewhere.

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
```

Every section is optional; unset values use the defaults shown above.
Aethon never crashes on a bad TOML file — it logs a parse error and
falls back to defaults.

## `[ui]`

| Key | Type | Default | Description |
|---|---|---|---|
| `theme` | `"ember" \| "paper" \| "aether" \| "brink" \| "daylight" \| "mist" \| "nocturne"` (or a registered theme id) | `"ember"` | Active theme. See [Themes](/guide/themes). |
| `font_size` | integer (10–22) | `14` | Base UI font size in pixels. |
| `restore_tabs` | boolean | `true` | Re-open all tabs from the previous session on launch. |
| `notify_on_completion` | boolean | `true` | Fire a native OS notification when a turn ends and the originating tab is unfocused. |
| `notify_min_duration_seconds` | integer | `8` | Minimum turn length (s) for the completion notification. Sub-second turns rarely need a ping. |

## `[agent]`

| Key | Type | Default | Description |
|---|---|---|---|
| `model` | string | provider default | The default model for new agent tabs. Format depends on the provider — `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`, etc. |

The model picker (`/model` slash command) updates the *active* tab's
model and persists the choice for new tabs.

## `[shell]`

Controls how PTY shell tabs are spawned and how they share data with
the agent. See [Shells & share modes](/guide/shells-and-share-modes) for
the full mental model.

| Key | Type | Default | Description |
|---|---|---|---|
| `default_share_mode` | `"private" \| "read" \| "read-write" \| "read-write-trusted"` | `"private"` | Initial share mode for new shell tabs. Anything else falls back to `"private"`. |
| `auto_restart_agent` | boolean | `true` | When the bun bridge crashes, respawn it automatically. Set `false` while debugging the bridge. |
| `default_command` | string | `""` (= `$SHELL`) | Override the program for new shell tabs (`"/usr/local/bin/fish"`, `"/bin/zsh"`, …). |
| `default_args` | `string[]` | `[]` | Extra argv appended after the platform default (e.g. `-il` on Unix). |
| `inherit_env` | boolean | `true` | Whether new shell tabs inherit Aethon's environment. Set `false` for hermetic shells. |
| `prompt_before_close` | boolean | `true` | When a shell's foreground job is *not* the shell itself (vim, npm test, ssh), prompt before killing on `Cmd+W`. |

## `[shortcuts]`

| Key | Type | Default | Description |
|---|---|---|---|
| `new_tab_kind` | `"agent" \| "shell"` | `"agent"` | What `Cmd+T` opens when focus is *outside* the bottom panel. `"agent"` keeps the focus-aware default; `"shell"` makes `Cmd+T` always open a shell tab. |

## `[voice]`

| Key | Type | Default | Description |
|---|---|---|---|
| `toggle_hotkey` | string | `"mod+shift+m"` | Keyboard combo for toggling voice input. `mod` means Cmd on macOS and Ctrl elsewhere. |
| `hold_hotkey` | string or unset | `"AltRight"` on macOS, unset elsewhere | Optional hold-to-record physical key. |

## `[extensions]`

| Key | Type | Default | Description |
|---|---|---|---|
| `state_warn_kb` | integer | `64` | Soft warning threshold for extension `setState` payloads. Clamped to 1-8192 KB. |
| `state_hard_kb` | integer | `512` | Hard rejection threshold for extension `setState` payloads. Clamped to 1-8192 KB and never below the warning threshold. |

## `[updates]`

| Key | Type | Default | Description |
|---|---|---|---|
| `channel` | `"stable" \| "nightly"` | `"stable"` | Which updater manifest to check. Unknown values fall back to `"stable"`. |
| `disable_auto_check` | boolean | `false` | Disable background update checks. Manual "Check for Updates" still works. |

## `[devshell]`

Controls Nix devshell detection for shell tabs and the agent's pi `bash`
tool. Per-project overrides use the same shape at
`<project>/.aethon/devshell.toml`.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | `"auto" \| "always" \| "never"` | `"auto"` | Detect devshells from marker files, force resolution, or disable wrapping. |
| `mode` | `"auto" \| "direnv" \| "nix" \| "nix-shell"` | `"auto"` | Resolver preference. `auto` uses `direnv` before flake before `shell.nix`. |
| `cache_ttl_hours` | integer | `720` | Max age for successful on-disk snapshots. `0` disables time-based eviction. |
| `refresh_on_lockfile_change` | boolean | `true` | Re-resolve when watched lockfile or marker mtimes change. |

## Hot-reload

Most fields take effect on the next render. A few require restart:

- `font_size`, `theme` — applied immediately.
- `default_share_mode` — applies to **new** shell tabs only.
- `restore_tabs`, `default_command`, `default_args`, `inherit_env`,
  `auto_restart_agent`, `devshell.*` — applied on next launch, next
  spawn, or explicit devshell refresh depending on the field.

## Where to next

- [Themes](/guide/themes) — registering custom themes.
- [Extensions](/guide/extensions) — extending Aethon.
- [Reference: config.toml](/reference/config-reference) — exhaustive schema.
