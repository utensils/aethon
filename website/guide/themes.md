# Themes

A **theme** in Aethon controls the entire visible palette — not just
chrome colors, but also code-syntax highlighting, terminal ANSI, and
status colors. Switching themes re-skins everything: chat, shells,
composers, sidebars, badges, code blocks.

## The three built-in themes

| Theme | `id` | Mood |
|---|---|---|
| **Ember** | `ember` | Warm dark — near-black with brass accent (`#ff6a18`). The default. |
| **Paper** | `paper` | Cream light — Bodoni-on-paper. The brass accent is darkened to `#d4530c` for 4.5:1 contrast. |
| **Æther** | `aether` | Deep ink-blue — the signature palette behind the four shipped layouts. |

::: tip
The site you're reading uses two of these themes: **Paper** in light mode,
**Ember** in dark mode. Toggle with the moon/sun icon in the top nav.
:::

`signature` is preserved as a back-compat alias for `aether` — any
persisted theme value of `signature` from older builds resolves to the
same palette.

## Switching themes

Four paths:

1. **Slash command** — `/theme <id>`.
2. **Command palette** — `Cmd+Shift+P`, search "theme", pick.
3. **Settings panel** — `Cmd+,`, scroll to **Theme**, pick.
4. **Direct edit** — `[ui] theme = "paper"` in `config.toml`.

The active theme is persisted; relaunch restores it.

## How themes work

Aethon themes are **CSS-variable bundles**. Setting `data-theme="ember"`
on `<html>` switches a single attribute and the cascading CSS variables
update everything downstream — including:

- App chrome (`--bg`, `--text`, `--accent`, `--border`, …).
- Code highlighting (`--syntax-keyword`, `--syntax-string`, `--syntax-comment`, …).
- Terminal palette (`--terminal-bg`, `--terminal-cursor`, `--ansi-red`, all 16 ANSI swatches, …).
- Status colors (`--success`, `--warn`, `--error`).

This is why a theme change re-skins the shells too: xterm reads its
colors from the same CSS variable surface.

## Registering custom themes

There are two ways to ship a custom theme.

### Drop-in JSON

Save a theme file at `~/.aethon/themes/<id>.json`:

```json
{
  "id": "midnight",
  "label": "Midnight",
  "vars": {
    "--bg": "#0a0a12",
    "--bg-elev": "#11111c",
    "--bg-input": "#181826",
    "--border": "#2a2a3a",
    "--text": "#e8e8f0",
    "--text-dim": "#888899",
    "--accent": "#7c8cff",
    "--accent-soft": "rgba(124, 140, 255, 0.18)",
    "--btn-text": "#0a0a12",
    "--success": "#5cd68a",
    "--warn": "#ffc94e",
    "--error": "#ff7777",
    "--terminal-bg": "#0a0a12",
    "--terminal-fg": "#e8e8f0",
    "--terminal-cursor": "#7c8cff"
  }
}
```

Aethon picks it up on next launch (or when the bridge reloads). The id
must not collide with the reserved built-ins (`ember`, `paper`, `aether`,
`signature`).

### Programmatic registration (extensions)

```ts
aethon.registerTheme({
  id: "midnight",
  label: "Midnight",
  vars: {
    "--bg": "#0a0a12",
    "--accent": "#7c8cff",
    /* …all the variables above… */
  },
});
```

This re-runs whenever the extension reloads. Useful for extensions that
ship a coordinated layout-plus-theme bundle.

## Required variables

A custom theme **should** override at least these for a coherent look:

| Variable | Purpose |
|---|---|
| `--bg`, `--bg-elev`, `--bg-input` | Chrome surfaces. |
| `--border` | Dividers and component borders. |
| `--text`, `--text-dim` | Primary and secondary text. |
| `--accent`, `--accent-soft` | Brand accent (links, focus rings, badges). |
| `--btn-text` | Foreground color on accent-filled buttons (must contrast `--accent`). |
| `--success`, `--warn`, `--error` | Status colors. |
| `--terminal-bg`, `--terminal-fg`, `--terminal-cursor` | xterm chrome. |
| `--ansi-{black,red,green,yellow,blue,magenta,cyan,white}` plus `--ansi-bright-*` | xterm ANSI palette. |
| `--syntax-{keyword,string,number,comment,…}` | Code block highlighting. |

Anything you don't set falls through to the **Ember** palette.

## Listing registered themes

`/extensions` shows every loaded extension; the Settings panel and the
sidebar **Themes** section enumerate every registered theme.

## Where to next

- [Extensions](/guide/extensions) — the full extension surface.
- [Configuration](/guide/configuration) — `[ui] theme` in `config.toml`.
- [Runtime API reference](/reference/runtime-api) — `aethon.registerTheme` signature.
