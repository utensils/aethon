# Troubleshooting

## The agent never responds

The most common cause is a missing provider key. Pi reads
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. from the environment Aethon
inherits — if those aren't visible to the GUI app, pi can't reach a
provider.

**Check:**

- Open a terminal and confirm `echo $ANTHROPIC_API_KEY` (or your
  provider's env var) prints the key.
- On macOS, GUI apps launched from Finder don't always inherit
  `~/.zshrc` exports. Either:
  - Launch Aethon from a terminal: `open -a Aethon`.
  - Export the key with `launchctl setenv ANTHROPIC_API_KEY sk-ant-...`.
  - Add a `~/Library/LaunchAgents/aethon-env.plist`.
- The bun agent bridge logs to stderr — see "Reading the logs" below.

## Reading the logs

Aethon's Tauri shell forwards all bun-bridge stderr to the OS console.

| Platform | Where                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------- |
| macOS    | **Console.app** → search for `aethon`                                                          |
| Linux    | `journalctl --user -t aethon` (if launched via `.desktop`) or stdout if launched from terminal |
| Windows  | `%LOCALAPPDATA%\aethon\` log files                                                             |

In a dev build (`dev`), stderr streams directly to your terminal.

## The agent's bash output isn't streaming

The "Agent bash" sub-tab shows output for the **active** agent tab.
Switching to a different agent tab swaps in _that_ tab's bash buffer.
A tab whose agent hasn't run any bash yet shows the placeholder text.

If a tab _has_ run bash and the panel is still blank:

- Toggle the panel (`Cmd+\``) to force a re-render.
- Confirm the agent process is healthy — `/extensions` should list
  at least the default-layout skill.
- Check stderr for bridge errors.

## A shell tab's PTY won't open

Some platforms refuse to open more than a small number of PTYs as a
single user. If `Cmd+Shift+T` produces no new sub-tab, check stderr
for `portable_pty: failed to allocate pty`.

`/proc/sys/kernel/pty/max` (Linux) and `kern.tty.maxptys` (macOS)
control the system limit; the per-user limit is usually well below
that.

## The window is blank after launch

Two paths to recovery:

1. **Force the default layout** — the dev console (`F12` in debug builds)
   exposes `window.aethon.resetLayout()`. Without dev tools, a manual
   recovery is to delete `~/.aethon/state.json` and relaunch.

2. **Check `~/.aethon/config.toml`** — a malformed file is parsed
   leniently (Aethon falls back to defaults), but a custom theme id
   that no extension provides any more will show black-on-black for
   any unset variables. Fall back to `theme = "ember"` and re-pick.

## "Extension failed to load"

Every extension load surfaces an `extension_lifecycle` chat event with
the source path and the error. Common causes:

- **Syntax error** — TypeScript-only syntax in a `.ts` that the bridge
  can't transform. Stick to syntax bun supports out of the box.
- **Missing import** — the bridge doesn't `npm install` for you.
  Bring your own deps (or use `~/.aethon/skills/` and install them
  there with npm).
- **Permission error** — the file is readable by the user running
  Aethon? Check `ls -l`.

`/extensions` shows the failed extension with its error so you don't
have to dig through logs.

## The terminal panel renders blank or with bad colors

xterm.js + WebGL can fall over on some Linux setups (older Mesa,
software rendering). Aethon falls back to the canvas renderer if WebGL
fails to initialise. If colors are wrong:

- Cycle the theme (`/theme paper && /theme ember`) — re-emits the ANSI
  palette.
- Restart the shell sub-tab (`Cmd+W` then `Cmd+Shift+T`).

## Reset everything

If you want to nuke local state and start over:

```bash
# Tabs, sessions, extensions, themes — all gone.
rm -rf ~/.aethon
```

Aethon recreates the directory on next launch with fresh defaults.

## Reporting a bug

Open an issue at <https://github.com/utensils/aethon/issues>. Include:

- OS and version.
- Aethon version (sidebar title row, macOS About dialog, or the
  `version` field in `package.json` for local dev builds).
- The contents of `~/.aethon/state.json` (sanitize keys if they contain
  anything sensitive).
- Stderr from the bun bridge (Console.app / journalctl / log file).
- The minimal reproduction.

## Where to next

- [Installation](/guide/installation) — first-run setup.
- [Configuration](/guide/configuration) — `~/.aethon/config.toml`.
- [Settings & search](/guide/settings-and-search) — Settings panel and reset.
