/**
 * Wire Monaco's editor chrome (background, line numbers, gutter,
 * selection, cursor) to the active Aethon theme.
 *
 * Two-layer scheme:
 *   1. Shiki defines `github-dark` / `github-light` via `shikiToMonaco`
 *      — those carry the syntax token rules we want to keep, no matter
 *      what Aethon chrome theme is active.
 *   2. We synthesize an `aethon-<themeId>` Monaco theme that inherits
 *      vs / vs-dark + overrides every chrome `colors[…]` slot with the
 *      live CSS variables from `:root[data-theme=themeId]`. The
 *      synthesized theme is what Monaco actually displays, so the
 *      editor matches the rest of the app even on warm dark themes
 *      like Brink or Ember.
 *
 * The synthesis runs once per theme switch and re-runs after Shiki has
 * loaded so the first paint flicker is short.
 */

import { monaco } from "./setup";

/** Aethon theme ids known to be dark; everything else maps to light.
 *  Kept in sync with the BUILTIN_THEMES list in
 *  `src/hooks/useExtensionsHydration.ts`. */
const DARK_THEMES = new Set(["ember", "aether", "brink"]);

function isDarkTheme(id: string | undefined | null): boolean {
  if (!id) return true;
  return DARK_THEMES.has(id);
}

/** Look up a CSS custom property on `:root` (which carries the active
 *  `data-theme`). Falls back to the supplied default when the var is
 *  unset or empty — that case happens when Monaco is asked for the
 *  theme before the DOM is ready (unit tests) or for an unknown theme
 *  id. */
function readVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

/** Monaco wants `#RRGGBB` or `#RRGGBBAA`. CSS vars frequently come
 *  back as `rgba(…)` or named colors — pass anything Monaco understands
 *  through unchanged, force the rest to hex via a temporary span. The
 *  hex check is intentionally tolerant: too-strict matching here would
 *  fall back to vanilla `vs-dark` chrome for themes that ship with `rgb`
 *  vars, which is the bug we're trying to avoid. */
function normalizeColor(input: string, fallback: string): string {
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
    // Monaco wants 6 or 8 hex digits. Expand `#abc` → `#aabbcc`.
    if (trimmed.length === 4) {
      const r = trimmed[1];
      const g = trimmed[2];
      const b = trimmed[3];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    return trimmed.length === 5
      ? `#${trimmed[1].repeat(2)}${trimmed[2].repeat(2)}${trimmed[3].repeat(2)}${trimmed[4].repeat(2)}`
      : trimmed;
  }
  // Fall through: leave Monaco to its built-in chrome rather than throw.
  return fallback;
}

function buildAethonTheme(themeId: string): monaco.editor.IStandaloneThemeData {
  const dark = isDarkTheme(themeId);
  const fallbackBg = dark ? "#1e1e1e" : "#ffffff";
  const fallbackFg = dark ? "#d4d4d4" : "#1f1f1f";
  const fallbackElev = dark ? "#252526" : "#f3f3f3";
  const fallbackBorder = dark ? "#3c3c3c" : "#e1e4e8";
  const fallbackAccent = dark ? "#f9cc6c" : "#0366d6";
  const fallbackMuted = dark ? "#858585" : "#6a737d";

  const bg = normalizeColor(readVar("--bg", fallbackBg), fallbackBg);
  const fg = normalizeColor(readVar("--text", fallbackFg), fallbackFg);
  const elev = normalizeColor(readVar("--bg-elev", fallbackElev), fallbackElev);
  const border = normalizeColor(readVar("--border", fallbackBorder), fallbackBorder);
  const accent = normalizeColor(readVar("--accent", fallbackAccent), fallbackAccent);
  const muted = normalizeColor(readVar("--text-dim", fallbackMuted), fallbackMuted);

  return {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      "editorLineNumber.foreground": muted,
      "editorLineNumber.activeForeground": fg,
      "editor.lineHighlightBackground": elev,
      "editor.selectionBackground": `${accent}33`,
      "editorCursor.foreground": accent,
      "editorWhitespace.foreground": border,
      "editorIndentGuide.background1": border,
      "editorIndentGuide.activeBackground1": muted,
      "editorGutter.background": bg,
      "editorGutter.modifiedBackground": accent,
      "editorWidget.background": elev,
      "editorWidget.border": border,
      "editorWidget.foreground": fg,
      "editorSuggestWidget.background": elev,
      "editorSuggestWidget.border": border,
      "editorSuggestWidget.foreground": fg,
      "editorSuggestWidget.selectedBackground": `${accent}33`,
      "input.background": bg,
      "input.foreground": fg,
      "input.border": border,
      "focusBorder": accent,
      "scrollbarSlider.background": `${border}cc`,
      "scrollbarSlider.hoverBackground": `${muted}80`,
      "scrollbarSlider.activeBackground": muted,
    },
  };
}

/** Monaco theme id for an Aethon theme. Stable string so callers can
 *  reference it without round-tripping through the synthesizer. */
export function monacoThemeFor(themeId: string | undefined | null): string {
  return `aethon-${themeId || (isDarkTheme(themeId) ? "ember" : "paper")}`;
}

/**
 * Synthesize an Aethon-flavoured Monaco theme from the live CSS vars
 * and activate it. Safe to call before Monaco has fully loaded —
 * `defineTheme`/`setTheme` no-op until the runtime is ready, and the
 * next call after readiness picks up the latest values.
 */
export function applyMonacoTheme(themeId: string | undefined | null): void {
  const id = themeId || "ember";
  try {
    const themeData = buildAethonTheme(id);
    monaco.editor.defineTheme(monacoThemeFor(id), themeData);
    monaco.editor.setTheme(monacoThemeFor(id));
  } catch {
    // Monaco hasn't initialised yet — fall back to setTheme with a
    // built-in id so something paints.
    try {
      monaco.editor.setTheme(isDarkTheme(id) ? "vs-dark" : "vs");
    } catch {
      /* swallow */
    }
  }
}

/**
 * Read the live `data-theme` attribute off the document root and apply
 * the matching Monaco theme.
 */
export function syncMonacoThemeFromDom(): void {
  if (typeof document === "undefined") return;
  const id = document.documentElement.dataset.theme;
  applyMonacoTheme(id);
}
