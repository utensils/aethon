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
```

Every section is optional; unset values use the defaults shown above.
Aethon never crashes on a bad TOML file — it logs a parse error and
falls back to defaults.

## `[ui]`

| Key | Type | Default | Description |
|---|---|---|---|
| `theme` | `"ember" \| "paper" \| "aether"` (or a registered theme id) | `"ember"` | Active theme. See [Themes](/guide/themes). |
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

## Hot-reload

Most fields take effect on the next render. A few require restart:

- `font_size`, `theme` — applied immediately.
- `default_share_mode` — applies to **new** shell tabs only.
- `restore_tabs`, `default_command`, `default_args`, `inherit_env`,
  `auto_restart_agent` — applied on next launch / next spawn.

## Where to next

- [Themes](/guide/themes) — registering custom themes.
- [Skills & extensions](/guide/skills-and-extensions) — extending Aethon.
- [Reference: config.toml](/reference/config-reference) — exhaustive schema.
