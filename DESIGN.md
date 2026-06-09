---
name: Aethon
description: An agent-driven desktop shell. The agent decides what you see.
colors:
  # Primary — Ember Brass, the brand through-line. The accent shifts per
  # theme (noted in §2); these are the canonical anchors.
  brand-flame: "#ff6a18"
  ember-brass: "#ff7a29"
  brass-paper: "#b8400a"
  brass-aether: "#ff8a3d"
  # Secondary — the cool counterweight that keeps the warm accent from
  # reading as monochrome.
  teal-ember: "#4dd6cf"
  inkblue-paper: "#2f5793"
  steel-aether: "#6fb0ff"
  # Tertiary — warm gold, used sparingly for highlight numerals and
  # tertiary chips.
  gold-ember: "#ffc24d"
  # Neutral — Ember (default dark): cream ink on warm near-black.
  ink-cream: "#fbeede"
  ink-cream-dim: "#9a9189"
  surface-ember-bg: "#121113"
  surface-ember-elev: "#1a181b"
  surface-ember-card: "#221f23"
  border-ember: "#2c2930"
  # Neutral — Paper (default light): crisp ink on cool near-white.
  ink-paper: "#1c1b19"
  ink-paper-dim: "#79756c"
  surface-paper-bg: "#f7f6f3"
  surface-paper-elev: "#fcfbf9"
  surface-paper-card: "#ffffff"
  border-paper: "#ddd8ce"
typography:
  display:
    fontFamily: "Geist, Inter, system-ui, sans-serif"
    fontSize: "1.4rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Geist, Inter, system-ui, sans-serif"
    fontSize: "1.08rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Geist, Inter, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  caption:
    fontFamily: "Geist, Inter, system-ui, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "0.005em"
  code:
    fontFamily: "Geist Mono, JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.86rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
rounded:
  xs: "3px"
  sm: "5px"
  md: "8px"
  lg: "12px"
  pill: "999px"
  circle: "50%"
spacing:
  px: "1px"
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  10: "40px"
  12: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ember-brass}"
    textColor: "#1a120a"
    rounded: "{rounded.md}"
    padding: "10px 24px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-cream}"
    rounded: "{rounded.md}"
    padding: "10px 20px"
  card:
    backgroundColor: "{colors.surface-ember-card}"
    textColor: "{colors.ink-cream}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input:
    backgroundColor: "{colors.surface-ember-elev}"
    textColor: "{colors.ink-cream}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  pill:
    backgroundColor: "{colors.surface-ember-elev}"
    textColor: "{colors.ink-cream-dim}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
---

# Design System: Aethon

## 1. Overview

**Creative North Star: "The Sun Chariot"**

Aethon is named for Αἴθων, one of the horses that pulled Helios's sun chariot:
the blazing one. The visual system answers to that image. A warm near-black
field (the night before dawn) is shaped by a single moving source of warm
light: the brass-orange accent the agent uses to mark what matters. The agent
is the light; the chrome is the dark sky it crosses. Nothing on screen glows by
default. Heat appears where the agent, or the user's own action, puts it.

The system is **calm at rest and warm on contact.** Surfaces sit flat and quiet
until something happens to them: a hover tint, a focus ring, a popover lifting
on a spring. Depth in the dark themes comes from layered warm-black surface
tiers and a faint radial glow bleeding down from the top of the window, not from
heavy drop shadows scattered everywhere. The accent is rationed. Its rarity is
what lets it read as illumination rather than branding.

This is a developer tool that refuses three easy defaults. It is **not a generic
VitePress install** dressed in stock brand colors, **not an overwrought** field
of gradients and glass and ambient animation, and **not a sterile,
personality-free** API reference with the myth scrubbed out. Aethon has a name
with a story and the surface carries it.

**Key Characteristics:**
- Warm near-black or crisp near-white ground, never gray-neutral SaaS.
- One rationed brass-orange accent as the system's only voice of emphasis.
- Flat at rest; warmth, glow, and lift are state responses, not decoration.
- Geist throughout: one humanist-geometric family doing display and body, with
  Geist Mono for everything machine-spoken.
- Seven shipped themes from one token contract, light and dark as equals.

## 2. Colors: The Ember Brass Palette

A rationed warm accent over warm-neutral grounds, with a cool secondary kept in
reserve so the warmth never tips into monochrome. Color roles are theme-stable;
the exact hex shifts per palette, but the role and the rarity do not.

### Primary
- **Ember Brass** (`#ff7a29`, the default Ember theme; `#ff6a18` is the canonical
  brand flame used for the favicon theme-color and the docs hero): the single
  voice of emphasis. Primary buttons, active nav, focus rings, the cursor, the
  link color, syntax keywords. On light **Paper** it deepens to a terracotta
  **Brass Paper** (`#b8400a`) so white button text clears WCAG AA; on **Æther**
  it brightens to **Brass Æther** (`#ff8a3d`) against the cosmic ink-blue base.
- **The One Flame Rule.** The accent marks at most one primary action per view.
  If two things on screen are both brass, neither reads as the thing to do next.
  Demote one to ghost or text.

### Secondary
- **Teal Ember** (`#4dd6cf` on Ember; **Ink-Blue Paper** `#2f5793`; **Steel
  Æther** `#6fb0ff`): the cool counterweight. Used for the informational state
  (`info`), secondary accent surfaces, and to stop a warm-on-warm screen from
  collapsing into one temperature. Never competes with primary for "the action";
  it carries "the other thing."

### Tertiary
- **Gold Ember** (`#ffc24d`): warm highlight for tertiary chips and numerals.
  Rare. When in doubt, it is not gold; it is primary or nothing.

### Neutral — Ember (default dark)
- **Cream Ink** (`#fbeede`): primary text. Warm off-white, never pure `#fff`,
  so it sits in the same temperature as the accent.
- **Cream Dim** (`#9a9189`): metadata, timestamps, captions. Holds ≥4.5:1 on the
  Ember ground.
- **Warm Near-Black** ground (`#121113` bg → `#1a181b` elevated → `#221f23`
  card): a four-step warm-black surface ramp (`--surface-0..4`). Depth is tonal
  layering, not shadow.
- **Border Ember** (`#2c2930`): hairline 1px dividers; `#3a363f` on hover,
  `#4e4954` for strong separation.

### Neutral — Paper (default light)
- **Paper Ink** (`#1c1b19`): primary text, near-black warm ink on bright stock.
- **Paper Dim** (`#79756c`): metadata. Bumped toward ink (not light gray) so
  body-adjacent text clears AA on the near-white ground.
- **Paper Stock** (`#f7f6f3` bg → `#fcfbf9` elevated → `#ffffff` card): crisp,
  cool-leaning near-white. Pure-white cards float a hair above the stock.
- **Border Paper** (`#ddd8ce`): crisp 1px hairline.

### Named Rules
**The Warm-Black Rule.** Dark grounds are warm near-black (hue pulled toward the
accent), never `#000` and never blue-gray-neutral. Light grounds are warm or
cool near-white per theme, never the cream/sand/parchment band. The temperature
of the ground always relates to the theme's accent.

**The Seven-Theme Contract.** The palette is not one set of colors; it is a token
contract (`--bg`, `--accent`, `--surface-0..4`, the state quads, the ANSI 16)
filled by seven shipped themes: **Ember** (default, warm near-black + brass),
**Paper** (crisp light + terracotta), **Æther** (cosmic ink-blue + brass/steel),
**Brink** (warm chrome + gold), **Daylight** (golden honey light), **Mist** (cool
teal fog light), **Nocturne** (neon navy). Any new surface must read correctly in
all of them by consuming tokens, never hardcoded hex.

## 3. Typography

**Display / Body Font:** Geist (with Inter, then system-ui, as graceful
fallbacks when web fonts are unreachable).
**Mono Font:** Geist Mono (with JetBrains Mono, then ui-monospace).

**Character:** One humanist-geometric family carries both display and body. The
hierarchy is built from weight and size contrast, not from a competing second
typeface. Geist is precise without being cold, which is exactly the brand voice:
expert, plain-spoken, a little warm. Geist Mono handles everything the machine
speaks: code, terminal output, file paths, the agent's tool I/O. The
sans/mono split is semantic, not decorative; mono means "this is literal."

### Hierarchy
- **Display** (Geist 600, `1.4rem`, line-height 1.2, tracking -0.015em): in-app
  hero numerals and splash titles. On the docs landing the hero name scales up
  on a fluid `clamp()` (VitePress hero), but it is the same Geist family and
  stays under the ~96px ceiling.
- **Title** (Geist 600, `1.08rem`, line-height 1.3, tracking -0.005em): section
  headings, panel titles, tab labels.
- **Body** (Geist 400, `0.95rem`, line-height 1.5): primary running text and
  chat. Cap measure at 65–75ch in prose contexts (the docs content column).
- **Caption** (Geist 500, `0.78rem`, line-height 1.45, tracking 0.005em): helper
  text, metadata, timestamps.
- **Code** (Geist Mono 400, `0.86rem`, line-height 1.55): inline and block code,
  terminal lines, syntax-highlighted output.

### Named Rules
**The One-Family Rule.** Geist does display and body; do not introduce a second
display face for "personality." Personality comes from weight, size, and the
brass accent, not from a typeface change. Mono is the only permitted second
family, and only for literal machine text.

**The Caps-Label Rule.** Uppercase is reserved for short eyebrow labels (≤4
words) at `0.04em` tracking, in `--text-dim`. Never set a sentence, a heading, or
body copy in all caps.

## 4. Elevation

Aethon is **flat at rest.** Depth is built first from tonal surface layering
(`--surface-0` through `--surface-4`) and only second from shadow. In the dark
themes a faint warm **radial glow** bleeds down from the top of the window
(`--gradient-app-backdrop`) and a 1px **inner highlight** catches the top edge of
elevated panels (`--inner-highlight`); together they read as ambient light, not
as a hard rectangle. In the light themes (Paper, Mist) shadows are restrained
neutral-gray and surfaces stay crisp. The five-step shadow scale is reserved for
genuinely-lifted UI.

### Shadow Vocabulary
The shadow scale is composed from a shared shape (`--elev-N-shape`: offset +
blur) and a per-theme color tint (`--elev-N-color`), so every theme keeps the
same elevation geometry but its own depth and warmth.
- **`--shadow-1`** (`0 1px 2px`): cards, inline chips. A tight, hugging shadow.
- **`--shadow-2`** (`0 4px 12px`): agent messages, sidebars, settled panels.
- **`--shadow-3`** (`0 12px 32px`): popovers, dropdowns.
- **`--shadow-4`** (`0 20px 56px`): command palette, settings overlay.
- **`--shadow-5`** (`0 32px 80px`): toasts and raised modals.

### Named Rules
**The Glow-Is-Earned Rule.** Surfaces are flat at rest. Glow, lift, and shadow
appear only as a response to state: hover, focus, elevation onto a higher layer,
or the ambient backdrop. A card that glows while sitting still is wrong.

**The Tonal-First Rule.** Before reaching for a shadow, move the surface up a tier
(`--surface-2` → `--surface-3`). Shadow is the second tool for depth, not the
first. If it looks like a 2014 app, the shadow is too dark and the blur is too
small; use a surface tier and the inner highlight instead.

## 5. Components

### Buttons
- **Shape:** gently rounded (`8px`, `{rounded.md}`).
- **Primary:** solid `--accent` fill, `--btn-text` label (a near-black tuned per
  theme so text clears AA on the accent), `10px 24px` padding, weight 600.
- **Hover / Focus:** primary dims to `opacity: 0.88` on hover, `0.78` on active
  (no color shift); focus shows `--focus-ring` (a 3px `--accent-soft` ring).
  Transitions run on `--motion-fast` (120ms).
- **Ghost (secondary):** transparent fill, 1px `--border`, `--text` label,
  `10px 20px`. Hover fills `--accent-hover-tint`; active deepens to
  `--accent-active-tint` and shifts the label and border to `--accent`. This is
  the "Open Project…" / alt-CTA treatment.

### Chips / Pills
- **Style:** `--pill-bg` (the accent mixed a few percent into the elevated
  surface), 1px `--pill-border`, `--pill-text` (`--text-secondary`), fully
  rounded (`{rounded.pill}`).
- **State:** selected chips take `--accent-soft` background with an `--accent`
  label. Uppercase metadata labels use `0.04em` tracking in `--text-dim`.

### Cards / Containers
- **Corner Style:** `12px` (`{rounded.lg}`).
- **Background:** `--card-bg` (`--surface-3`); pure-white in Paper, warm-black in
  Ember.
- **Shadow Strategy:** `--card-shadow` is `--shadow-2` in dark themes, the lighter
  `--shadow-1` in Paper. See §4.
- **Border:** 1px `--card-border`.
- **Internal Padding:** `16px` (`{spacing.4}`); looser sections step to `20–24px`.
- **Cards are not the default container.** Use them when grouping genuinely
  benefits from a bounded surface. Never nest a card inside a card.

### Inputs / Fields
- **Style:** `--bg-input` fill, 1px `--border`, `8px` radius.
- **Focus:** border shifts toward `--accent` and the `--focus-ring` glow appears;
  no layout shift.
- **Composer:** the chat input is a raised surface (`--composer-bg`,
  `--composer-shadow` lifting upward) with the send button overlaid bottom-right.

### Navigation
- **Sidebar tree:** host → project → workspace, a single indented family sharing
  one gutter rhythm (`--ae-sb-*`). The active item pulses `--accent`; rows hover
  to `--bg-hover`, select to `--bg-selected` (an `--accent`-tinted wash).
- **Docs nav:** the active sidebar item is brass; the rest is `--text-2`.

### Signature Component — The Agent Canvas
Aethon's defining surface is not chrome at all: it is the **A2UI canvas** the
agent populates at runtime. The default workstation layout is itself an A2UI
payload, rendered by the same renderer that draws agent output. Components are
addressed by stable `type` strings and bound to one state store via JSON-Pointer
`$ref`s, so any chrome composite (sidebar, composer, command palette, terminal
panel) can be swapped by an extension. Design every new surface as a token-driven,
overridable A2UI component, never as hardcoded React chrome.

### Signature Component — The Terminal
PTY shells and the agent-bash stream render through a full ANSI-16 palette tuned
per theme (`--ansi-*`, `--terminal-*`). The terminal is a first-class themed
surface: its background, cursor, selection, and all 16 colors come from the same
theme contract as the chrome, so a TUI in a shell tab reads as part of Aethon,
not a foreign black box.

## 6. Do's and Don'ts

### Do:
- **Do** consume tokens, never hardcoded hex. Every surface must read correctly
  across all seven themes by reading `--bg`, `--accent`, `--surface-0..4`, the
  state quads, and `--ansi-*`.
- **Do** ration the accent to one primary action per view (The One Flame Rule).
  Its rarity is the point.
- **Do** keep surfaces flat at rest and let warmth, glow, and lift be state
  responses (The Glow-Is-Earned Rule).
- **Do** build depth from surface tiers first, shadow second (The Tonal-First
  Rule).
- **Do** carry both schemes: verify body text ≥4.5:1 and large text ≥3:1 in both
  Paper (light) and Ember (dark) before shipping. The site mirrors the OS theme.
- **Do** pair color with text, weight, or shape for status. Never let the brass
  accent be the only signal of state (color-vision deficiency).
- **Do** honor `prefers-reduced-motion`: motion tokens collapse to 0ms and the
  signature spinners/glows freeze. Every animation needs a reduced alternative.
- **Do** use Geist for everything human and Geist Mono for everything literal.

### Don't:
- **Don't** ship the **generic VitePress default**: stock brand green/blue, the
  untouched hero, an unconfigured-template look. The Ember/Paper identity is the
  point. (PRODUCT.md anti-reference.)
- **Don't** go **overwrought / loud**: no decorative gradients, no glassmorphism,
  no animation on everything. The accent signals illumination and clarity, not
  flash. (PRODUCT.md anti-reference.)
- **Don't** go **sterile / personality-free**: don't scrub the mythological
  warmth and authorial voice into a cold generated-API-reference look.
  (PRODUCT.md anti-reference.)
- **Don't** use a `border-left` / `border-right` colored stripe greater than 1px
  as an accent on cards, callouts, or list items. Use a full hairline, a tinted
  background, or a leading icon.
- **Don't** use gradient text (`background-clip: text` on a gradient). Emphasis
  comes from weight, size, and the solid brass accent. (The docs hero name was
  gradient-filled in an earlier build; it is now solid `--vp-c-brand-1`.)
- **Don't** set body copy or headings in all caps; reserve caps for ≤4-word
  eyebrow labels at `0.04em` tracking.
- **Don't** scatter same-sized icon + heading + text cards in an endless grid, or
  nest cards inside cards.
- **Don't** use `#000` dark grounds or gray-neutral SaaS surfaces; grounds are
  warm/cool near-black or near-white tied to the theme accent (The Warm-Black
  Rule).
- **Don't** introduce a second display typeface for personality. One family,
  weight contrast, brass accent (The One-Family Rule).
