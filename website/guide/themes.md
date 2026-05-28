# Themes

A **theme** in Aethon controls the entire visible palette — not just
chrome colors, but also code-syntax highlighting, terminal ANSI, and
status colors. Switching themes re-skins everything: chat, shells,
composers, sidebars, badges, code blocks.

## The seven built-in themes

| Theme | `id` | Mood |
|---|---|---|
| **Ember** | `ember` | Warm dark — near-black with brass accent (`#ff6a18`). The default. Teal secondary accent (`#4dc6c0`) breaks the brass monotony. |
| **Paper** | `paper` | Cream light — Bodoni-on-paper. Deep terracotta accent (`#b94000`) reads with authority on the cream bg; sage secondary (`#4f7d52`) for hierarchical CTAs. |
| **Æther** | `aether` | Deep ink-blue — the signature palette behind the four shipped layouts. Steel-blue secondary (`#6aa9ff`). |
| **Brink** | `brink` | Mid-tone warm chrome with gold accent (`#f9cc6c`) and lavender secondary (`#a8a9eb`). The header carries a Tokyo-Night slate (`#2d2f44`) wash — Claudette's signature "cool sky over warm ground" character. |
| **Daylight** | `daylight` | Rich warm light — parchment cream with deeper amber base, terracotta + sage dual-accent. "Paper but with more depth." |
| **Mist** | `mist` | Cool light — pale blue-gray base, mint primary accent (`#1f7d5e`), slate-blue secondary. Professional alternative to the warm light themes. |
| **Nocturne** | `nocturne` | High-contrast dark — deep navy (`#0a0d14`), electric cyan primary (`#28e0e0`), vivid magenta secondary. For demos, screen-sharing, projectors. |

::: tip
The site you're reading uses **Paper** in light mode and **Ember** in
dark mode. Toggle with the moon/sun icon in the top nav.
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
must not collide with the reserved built-ins: `ember`, `paper`, `aether`,
`signature`, `brink`, `daylight`, `mist`, `nocturne`.

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

### Polished-theme variables (opt-in)

The built-in themes also set roughly 30 extra tokens that lift the UI
from "flat two-plane palette" to a graduated design system. None of
these are required, but a custom theme that omits them will render
flat cards/pills/popovers compared to the built-ins.

| Category | Tokens | Why |
|---|---|---|
| Surface tiers | `--surface-0` … `--surface-4` | Graduated planes — sidebars sit brighter than canvas, cards/popovers/modals each get their own layer. |
| Secondary + tertiary accents | `--accent-2*`, `--text-on-accent-2`, `--accent-3*` | Hierarchical CTAs and informational chips so the UI doesn't read monochromatic. |
| Semantic state quads | `--state-{success,warning,error,info}-{bg,fg,border,strong}` | Banners, toasts, status chips. Adds `info` as a new state separate from the legacy `--success/--warn/--error` single colours. |
| Elevation tints | `--elev-1-color` … `--elev-5-color` | Paired with `--elev-N-shape` from `tokens.css` to compose `--shadow-1..5` + `--shadow-overlay`. |
| Inner highlight | `--inner-highlight` | A 1px top-edge sheen on elevated panels. Light themes use a strong white (≈0.6); dark themes a faint one (≈0.04–0.06). |
| Gradient stops | `--gradient-surface`, `--gradient-accent`, `--gradient-app-backdrop` | Sidebar/header wash, primary CTA gradient, soft radial behind the canvas. |
| Chrome composites | `--card-{bg,border,shadow}`, `--pill-{bg,border,text}`, `--composer-{bg,border,shadow}`, `--popover-{bg,border,shadow}`, `--modal-{bg,border,shadow}` | Semantic aliases chrome.css reads directly — override one to re-skin every card / pill / popover / modal in the app. The composer shadow is an **upward** (negative-Y) shadow since the composer sits above the canvas. |

A minimal "polished" theme overrides at least: every surface tier,
both accents, the four state quads, all five elevation tints, the
inner highlight, and the gradient stops. That's ~40 declarations.

### WCAG-AA contrast

All seven built-ins clear WCAG AA on every text/bg pair scanned by
the audit script. When introducing a custom theme, target:

- 4.5:1 for body text, secondary text, dim text, and CTA text on
  accent backgrounds.
- 3.0:1 for accent colours used as UI elements (button outlines,
  borders, focus rings) and syntax-comment-like decorative tokens.

If a theme picks a primary accent in the mid-luminance range, the
foreground will likely need to be pure `#ffffff` (cream/off-white
typically fails 4.5:1 on mid-luminance accents) — see Mist's
`--text-on-accent: #ffffff` for an example.

## Listing registered themes

`/extensions` shows every loaded extension; the Settings panel and the
sidebar **Themes** section enumerate every registered theme.

## Where to next

- [Extensions](/guide/extensions) — the full extension surface.
- [Configuration](/guide/configuration) — `[ui] theme` in `config.toml`.
- [Runtime API reference](/reference/runtime-api) — `aethon.registerTheme` signature.
