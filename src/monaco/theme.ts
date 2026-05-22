/**
 * Map an Aethon theme id to a Monaco editor theme and apply it.
 *
 * Monaco ships its own theme registry (`vs`, `vs-dark`, `hc-black`,
 * `hc-light`). For the v1 editor we mirror the active Aethon theme's
 * light/dark side onto Monaco's built-ins — that gives us functional
 * highlighting without dragging the Shiki worker's tokenisation onto
 * the main thread. A later polish step can bind a main-thread Shiki
 * highlighter via `@shikijs/monaco` to share grammars + palette with
 * chat code blocks.
 *
 * The mapping is driven by the same `data-theme` attribute the rest of
 * the app uses, so a single source of truth (the theme switcher in
 * `useZoomAndTheme`) drives both the CSS variables and Monaco.
 */

import { monaco } from "./setup";

/** Aethon theme ids known to be dark; everything else falls back to light. */
const DARK_THEMES = new Set(["ember", "aether", "brink"]);

/** Map a theme id (or the live `data-theme` value) to a Monaco theme id. */
export function monacoThemeFor(themeId: string | undefined | null): string {
  if (!themeId) return "vs-dark";
  return DARK_THEMES.has(themeId) ? "vs-dark" : "vs";
}

/**
 * Apply the Monaco theme that corresponds to the supplied Aethon theme.
 * Safe to call before Monaco has mounted — `setTheme` on a not-yet-loaded
 * Monaco is a no-op (the next call after mount picks up the latest value).
 */
export function applyMonacoTheme(themeId: string | undefined | null): void {
  try {
    monaco.editor.setTheme(monacoThemeFor(themeId));
  } catch {
    // Monaco hasn't initialised yet — first editor mount will read the
    // current data-theme value and call this again.
  }
}

/**
 * Read the live `data-theme` attribute off the document root and apply
 * the matching Monaco theme. Used as a one-shot reconciliation after
 * mount; the React side calls `applyMonacoTheme` directly on changes.
 */
export function syncMonacoThemeFromDom(): void {
  if (typeof document === "undefined") return;
  const id = document.documentElement.dataset.theme;
  applyMonacoTheme(id);
}
