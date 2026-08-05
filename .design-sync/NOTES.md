# design-sync notes — Aethon

Repo-specific gotchas for syncing Aethon's UI to claude.ai/design
(project `c4b961f5-c907-4920-acbe-7ce8053ee1cd`, "Aethon Design System").

## Shape / build

- This is a Tauri **app**, not a packaged library: no dist entry. The sync
  bundles from the committed barrel `src/design-system.ts` — pass
  `--entry ./src/design-system.ts` to `package-build.mjs`/`resync.mjs`.
  Keep the barrel and `componentSrcMap` in `.design-sync/config.json` in
  step when scope changes.
- **Pre-step before every build**: flatten the stylesheet entry —
  `npx esbuild .design-sync/styles-entry.css --bundle --outfile=.design-sync/.cache/styles-flat.css`
  (cfg.cssEntry points at the flattened output; a stale flat css ships
  stale tokens/chrome silently — always re-run after touching
  `src/styles/**`).
- `tokensGlob`/`tokensPkg` don't apply here (tokens are in-repo files, not
  a package) — tokens + themes travel inside the flattened cssEntry.
- The `?worker` Vite idiom in `src/utils/highlight.ts` was migrated to
  `new Worker(new URL(...))` + guarded spawn specifically so esbuild can
  bundle the `Code` primitive; tests stub `globalThis.Worker`
  (`vi.stubGlobal`), not a module mock. Don't reintroduce `?worker`
  default-imports anywhere the design-system barrel can reach.
- Fonts: @fontsource packages (Geist Sans/Mono, Inter, JetBrains Mono,
  Playfair Display) via `extraFonts`; `.design-sync/geist-alias.css`
  aliases family "Geist" (system-font first choice in `--font-ui`) onto
  the bundled Geist Sans woff2s — resolves `[FONT_MISSING] "Geist"`.

## Preview recipe (authored previews)

- Components take the A2UI envelope: `component={{id,type,props}}`,
  `state`, `onEvent` — never direct props (exceptions: Chevron,
  AeMarkInline, AeWordmark take plain props).
- The DS preview harness forces a white card body; Aethon components
  expect the app shell's themed surface. Every authored preview wraps
  cells in a local `Surface` div:
  `background: var(--bg); color: var(--text); fontFamily: var(--font-ui)`.
  Real designs DON'T need this — the styles.css closure carries chrome
  base.css's `body` rule.
- Shiki highlighting + line numbers need the highlight worker, which
  can't spawn in the static bundle: `Code` renders the plain-text
  fallback (frame + header + copy button still fully styled). By design —
  don't chase it, and don't author `showLineNumbers` stories.

## Component rendering facts (folded from wave 1 authoring)

- Envelope `type` strings are kebab-case: `text-input`, `date-picker`,
  `form-field`; the rest are lowercase single words.
- `Form`/`FormField`/`Card`/`Container` compose nested content ONLY via
  `renderChildren={() => JSX}` — a `children` prop is ignored.
- FormField auto-swaps description → error (`--error` red) when `error`
  is set; `required` appends an accent asterisk. Form `disabled` inerts
  children via `<fieldset disabled>` + opacity 0.6.
- DatePicker/Checkbox/Select/Slider are native inputs: DatePicker needs
  `YYYY-MM-DD` values; Slider collapses without a fixed-width container
  (~280px) and should always get `showValue`; Select's placeholder shows
  only with `placeholder` set AND no value; native checked/track accents
  render the OS default (blue), same as in the real app.
- Vertical Divider (`alignSelf: stretch`, width 1) collapses unless its
  parent is a fixed-height flex row (e.g. height 28, align center).
- Text variants map to semantic roles: body→`--type-body`,
  small→`--type-caption`, large→`--type-title`. Heading levels 1–2 render
  the display role, 3–6 the title role.
- Card surface = `--bg-elev` + `--border`, lifts off the base `--bg`.

## Component rendering facts (folded from wave 2 authoring)

- Chevron/AeMarkInline/AeWordmark take PLAIN props (no envelope). Chevron
  strokes `currentColor` — invisible off the dark Surface (this was the
  `[RENDER_BLANK]` fix). AeWordmark needs Playfair Display (bundled).
- Icon's glyph map has collisions (`terminal`/`folder` → ▣, `warning`/
  `error` → !); unknown names fall back to uppercased first letter;
  `symbol` overrides with a raw glyph.
- Image: never remote URLs (product CSP); inline SVG data URIs work.
  No `className` = framed figure mode (border/radius/caption).
- Layout (`type: "layout"`): preview must supply its own `renderChild`;
  children opt into regions via `props.area`; `areas` is an array of
  row strings joined into grid-template-areas.
- ComposerVisibilityPills takes `{state, tabId, onEvent}` directly.
- StatusBar prop wiring mirrors workstation.a2ui.json and is inverted
  from intuition: `left`←/status, `center`←/connection, `right`←/model,
  `context`←/contextUsage (full ContextUsageState; `contextWindow > 0`
  required or the meter drops). It's a full-window footer —
  `cfg.overrides.StatusBar = cardMode single @ 1180x220` (applied).
- EmptyState resolves recents inline or via `$ref`; full-canvas centered
  card, tall — Welcome variant bottom-crops in a grid cell (accepted).

## Known render warns (triaged)

- `[TOKENS_MISSING]` — orphan CSS vars referenced by chrome css but never
  defined anywhere in the app either: `--text-muted, --surface,
  --bg-elevated, --warning, --accent-contrast, --border-subtle,
  --accent-border` (+ `--shiki-*`, runtime-set by Shiki spans). Latent
  app inconsistency (~31 sites), none used by the 26 synced components
  (only `.a2ui-dashboard-issues-warning`, not synced). Reported to the
  user as an app finding; suggested cleanup: alias onto the real
  vocabulary (`--text-dim`, `--bg-elev`, …) in themes.css.

## Re-sync risks

- `.design-sync/.cache/styles-flat.css` is generated: on a fresh clone or
  after style edits it must be re-flattened BEFORE the driver run, or the
  bundle ships stale/absent CSS (validate then fails `[CSS_IMPORT_MISSING]`
  or ships stale tokens without failing).
- `src/design-system.ts` barrel and `componentSrcMap` must move together;
  a component added to one but not the other either drops from the bundle
  or loses its src enrichment.
- `dtsPropsFor` bodies in config are hand-written mirrors of each
  component's `props as {...}` cast — they rot silently if a primitive's
  props change. On re-sync, diff the flagged components' props casts
  against the config.
- Geist alias css points at `node_modules/@fontsource/geist-sans` paths —
  breaks silently if the @fontsource package layout changes.
- The user wants a **zip archive** of `ds-bundle/` at the end of each
  sync for use on another account (`aethon-design-system.zip`).
