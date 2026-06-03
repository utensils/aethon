# Shells & share modes

The **bottom terminal panel** (toggle `Cmd+\``) is a tabbed surface
hosting **two kinds of sub-tabs**:

| Sub-tab | What it is |
|---|---|
| **Agent bash** (always present) | A read-only live stream of the bash tool's stdout for the active agent tab. |
| **Shell sub-tab** (zero or more) | Full interactive PTYs — vim, htop, fzf, ssh. |

The top tab strip carries **only agent tabs**; shell sub-tabs render in
the bottom panel.

## Why a separate panel?

The agent's bash stream and your interactive shells are different
animals:

- The **Agent bash** stream is a *view* — you're watching the agent.
  You can't type into it.
- A **shell sub-tab** is *yours* — full PTY, full TTY, full TUI support.

Both being theme-aware xterm.js surfaces under the hood.

## Opening shells

| Action | Shortcut | Notes |
|---|---|---|
| Toggle the panel | `Cmd+\`` | Backtick. Same as iTerm2. |
| New shell sub-tab | `Cmd+Shift+T` | Auto-opens the panel. |
| New shell sub-tab (focus-aware) | `Cmd+T` | When focus is in the panel, `Cmd+T` opens a shell. |
| Close active sub-tab | `Cmd+W` | Prompts before killing a running job (configurable). |

::: tip `Cmd+T` is focus-aware
- Focus inside the bottom panel → opens a **shell** sub-tab.
- Focus elsewhere → opens an **agent** tab.

To make `Cmd+T` *always* open a shell, set `[shortcuts] new_tab_kind = "shell"`.
:::

## Capabilities

Shell sub-tabs are real PTYs (via `portable-pty`):

- Full TUI support — `vim`, `nvim`, `htop`, `fzf`, `tmux`, `less`.
- 256-color and true-color.
- Mouse reporting.
- Theme-aware ANSI palette — switching the Aethon theme re-skins ANSI.
- Status line under each terminal: `cwd · command · share-mode · cols×rows`.

The default shell program is `$SHELL`. Override globally via:

```toml
[shell]
default_command = "/usr/local/bin/fish"
default_args = ["-il"]
inherit_env = true
```

## Share modes — the privacy boundary

Each shell tab carries a **`shareMode`** that controls how much the
agent can see and do:

| Mode | Agent reads scrollback? | Agent writes input? | Allow/Deny prompt on writes? |
|---|---|---|---|
| `private` (default) | No | No | — |
| `read` | Yes (only after opt-in) | No | — |
| `read-write` | Yes | Yes | Yes — every keystroke batch |
| `read-write-trusted` | Yes | Yes | No |

The current mode appears as a clickable **badge** in the shell's status
line. Click it to cycle through modes; the change takes effect immediately.

::: warning Privacy floor
The privacy floor is enforced **Rust-side**. When you opt in (cycling
from `private` to `read`), the agent's read cursor starts at the
**current scrollback offset** — never further back. Scrollback from
before the opt-in is invisible to the agent forever.

There is intentionally **no `setShareMode` on the agent surface**.
Mode changes only happen when you click the badge.
:::

## How the agent uses shells

Extensions reach shells via three calls:

```ts
const shells = await aethon.shells.list();
//   →  { id, cwd, command, shareMode, cursor }[]

const page = await aethon.shells.read(shells[0].id);
//   →  { bytes, cursor, eof }

await aethon.shells.write(shells[0].id, "ls -la\n");
//   In `read-write` mode, this pops an Allow/Deny notification.
//   The user must approve before the keystrokes are sent.
//   In `read-write-trusted`, the write proceeds without a prompt.
```

`list()` returns **only shells the user has explicitly opted in to share**
(anything not `private`). The agent cannot enumerate `private` shells —
they're invisible.

## The Allow/Deny prompt

In `read-write` mode, every `aethon.shells.write` call surfaces a
**notification with Allow / Deny** actions:

<figure class="ae-wire" aria-label="A write-consent notification. It reads: extension team-helper wants to write to shell 1, then shows the command ls -la, with Deny and Allow buttons.">
<div class="ae-wire-dialog">
<div class="ae-wire-dialog-title">Extension <code>team-helper</code> wants to write to shell 1</div>
<div><code>ls -la</code></div>
<div class="ae-wire-actions"><span class="ae-wire-btn ae-wire-btn-deny">Deny</span><span class="ae-wire-btn ae-wire-btn-allow">Allow</span></div>
</div>
</figure>

The notification stays open until you decide. You can switch tabs while
it's pending.

To skip the prompt entirely (for shells you fully trust the agent in),
flip the mode to `read-write-trusted` with the badge.

## Configuring defaults

```toml
[shell]
default_share_mode = "private"      # Initial mode for new shells. Anything else falls back to "private".
prompt_before_close = true          # Confirm before killing a foreground job on Cmd+W.
```

Setting `default_share_mode = "read"` does **not** retroactively widen
existing shells; it only seeds new ones.

## Closing shells

`Cmd+W` closes the active sub-tab. If the shell's foreground job is
something other than the shell itself (vim, npm test, ssh), Aethon
prompts before killing — disable via `[shell] prompt_before_close = false`.

## Where to next

- [Configuration](/guide/configuration) — every `[shell]` key.
- [Extensions](/guide/extensions) — how extensions use the shells API.
- [Keyboard shortcuts](/reference/keyboard-shortcuts) — full reference.
