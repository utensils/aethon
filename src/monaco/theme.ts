/**
 * Aethon Monaco theme registry.
 *
 * Each Aethon CSS theme has a matching Monaco theme registered as
 * `aethon-<themeId>`. We register all four built-ins eagerly at boot
 * (pre-Monaco is fine — `defineTheme` is safe to call before any
 * editor exists) so the editor never has a window where it has to
 * fall back to vanilla `vs` / `vs-dark` and look out of place.
 *
 * Hard-coded rather than read from CSS vars on the fly: synthesising
 * from `getComputedStyle` introduced timing races on cold start
 * (theme persistence loaded after the canvas had already read the
 * default vars) and the reflection added more complexity than it
 * saved. The palette here is the same one in `src/styles.css` for
 * each `:root[data-theme="…"]` block — both should move together.
 *
 * Overrides: skills/extensions can replace any registered theme via
 * `aethon.registerMonacoTheme(id, data)` (mounted on `window.aethon`
 * by `useWindowApi`). The runtime registry is consulted first on
 * every `applyMonacoTheme(id)` call so a registration takes effect
 * without a reload.
 */

import { monaco } from "./setup";

/** Monaco theme id namespace used for the built-ins. */
const PREFIX = "aethon-";

interface ThemeRecord {
  data: monaco.editor.IStandaloneThemeData;
}

/** Live registry. Built-ins are seeded by `ensureRegistered()`; user
 *  / extension overrides land here via `registerMonacoTheme`. */
const REGISTRY = new Map<string, ThemeRecord>();
let bootSeeded = false;
let monacoDefined = false;

/** Default Aethon theme id for null/undefined input. Matches the
 *  initial value of `:root[data-theme]` in `useBootConfig`. */
const DEFAULT_ID = "ember";

/** Theme definitions — chrome only (`base + colors`). Token rules are
 *  inherited from the matching built-in (`vs` / `vs-dark`); when the
 *  Shiki bridge mounts it adds richer per-grammar tokenisation on top.
 *  Values are taken verbatim from `src/styles.css`. */
const BUILTIN_THEMES: Record<string, monaco.editor.IStandaloneThemeData> = {
  ember: {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#161618",
      "editor.foreground": "#e7e5e2",
      "editorLineNumber.foreground": "#5a5651",
      "editorLineNumber.activeForeground": "#e7e5e2",
      "editor.lineHighlightBackground": "#1f1e21",
      "editor.selectionBackground": "#ff6a182a",
      "editor.selectionHighlightBackground": "#ff6a181a",
      "editorCursor.foreground": "#ff6a18",
      "editorWhitespace.foreground": "#2c2a2d",
      "editorIndentGuide.background1": "#2c2a2d",
      "editorIndentGuide.activeBackground1": "#5a5651",
      "editorGutter.background": "#161618",
      "editorWidget.background": "#1f1e21",
      "editorWidget.border": "#2c2a2d",
      "editorWidget.foreground": "#e7e5e2",
      "editorSuggestWidget.background": "#1f1e21",
      "editorSuggestWidget.border": "#2c2a2d",
      "editorSuggestWidget.foreground": "#e7e5e2",
      "editorSuggestWidget.selectedBackground": "#ff6a1822",
      "input.background": "#1f1e21",
      "input.foreground": "#e7e5e2",
      "input.border": "#2c2a2d",
      focusBorder: "#ff6a18",
      "scrollbarSlider.background": "#2c2a2dcc",
      "scrollbarSlider.hoverBackground": "#5a565180",
      "scrollbarSlider.activeBackground": "#5a5651",
    },
  },
  paper: {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#fef3e2",
      "editor.foreground": "#1f1f23",
      "editorLineNumber.foreground": "#a39a87",
      "editorLineNumber.activeForeground": "#1f1f23",
      "editor.lineHighlightBackground": "#fffaee",
      "editor.selectionBackground": "#d4530c33",
      "editor.selectionHighlightBackground": "#d4530c1a",
      "editorCursor.foreground": "#d4530c",
      "editorWhitespace.foreground": "#e3d8be",
      "editorIndentGuide.background1": "#e3d8be",
      "editorIndentGuide.activeBackground1": "#a39a87",
      "editorGutter.background": "#fef3e2",
      "editorWidget.background": "#fffaee",
      "editorWidget.border": "#e3d8be",
      "editorWidget.foreground": "#1f1f23",
      "editorSuggestWidget.background": "#fffaee",
      "editorSuggestWidget.border": "#e3d8be",
      "editorSuggestWidget.foreground": "#1f1f23",
      "editorSuggestWidget.selectedBackground": "#d4530c22",
      "input.background": "#f5e8d0",
      "input.foreground": "#1f1f23",
      "input.border": "#e3d8be",
      focusBorder: "#d4530c",
      "scrollbarSlider.background": "#d8cdb3cc",
      "scrollbarSlider.hoverBackground": "#b8ad9480",
      "scrollbarSlider.activeBackground": "#b8ad94",
    },
  },
  aether: {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0e1118",
      "editor.foreground": "#d6dceb",
      "editorLineNumber.foreground": "#4e5670",
      "editorLineNumber.activeForeground": "#d6dceb",
      "editor.lineHighlightBackground": "#161a25",
      "editor.selectionBackground": "#7aa2f72a",
      "editor.selectionHighlightBackground": "#7aa2f71a",
      "editorCursor.foreground": "#7aa2f7",
      "editorWhitespace.foreground": "#252b3a",
      "editorIndentGuide.background1": "#252b3a",
      "editorIndentGuide.activeBackground1": "#4e5670",
      "editorGutter.background": "#0e1118",
      "editorWidget.background": "#161a25",
      "editorWidget.border": "#252b3a",
      "editorWidget.foreground": "#d6dceb",
      "editorSuggestWidget.background": "#161a25",
      "editorSuggestWidget.border": "#252b3a",
      "editorSuggestWidget.foreground": "#d6dceb",
      "editorSuggestWidget.selectedBackground": "#7aa2f722",
      "input.background": "#161a25",
      "input.foreground": "#d6dceb",
      "input.border": "#252b3a",
      focusBorder: "#7aa2f7",
      "scrollbarSlider.background": "#252b3acc",
      "scrollbarSlider.hoverBackground": "#4e567080",
      "scrollbarSlider.activeBackground": "#4e5670",
    },
  },
  brink: {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#2c2525",
      "editor.foreground": "#d9c8b4",
      "editorLineNumber.foreground": "#7a6c61",
      "editorLineNumber.activeForeground": "#d9c8b4",
      "editor.lineHighlightBackground": "#3a3030",
      "editor.selectionBackground": "#f9cc6c33",
      "editor.selectionHighlightBackground": "#f9cc6c1a",
      "editorCursor.foreground": "#f9cc6c",
      "editorWhitespace.foreground": "#504646",
      "editorIndentGuide.background1": "#504646",
      "editorIndentGuide.activeBackground1": "#7a6c61",
      "editorGutter.background": "#2c2525",
      "editorWidget.background": "#3a3030",
      "editorWidget.border": "#504646",
      "editorWidget.foreground": "#d9c8b4",
      "editorSuggestWidget.background": "#3a3030",
      "editorSuggestWidget.border": "#504646",
      "editorSuggestWidget.foreground": "#d9c8b4",
      "editorSuggestWidget.selectedBackground": "#f9cc6c22",
      "input.background": "#3a3030",
      "input.foreground": "#d9c8b4",
      "input.border": "#504646",
      focusBorder: "#f9cc6c",
      "scrollbarSlider.background": "#504646cc",
      "scrollbarSlider.hoverBackground": "#7a6c6180",
      "scrollbarSlider.activeBackground": "#7a6c61",
    },
  },
};

function seedBuiltins(): void {
  if (bootSeeded) return;
  for (const [id, data] of Object.entries(BUILTIN_THEMES)) {
    REGISTRY.set(id, { data });
  }
  bootSeeded = true;
}

function defineAllInMonaco(): void {
  if (monacoDefined) return;
  try {
    for (const [id, record] of REGISTRY) {
      monaco.editor.defineTheme(`${PREFIX}${id}`, record.data);
    }
    monacoDefined = true;
  } catch {
    // Monaco not ready yet — the next call will retry.
  }
}

/** Stable Monaco theme id for an Aethon theme. Used by callers that
 *  want to reference the theme without going through setTheme. */
export function monacoThemeFor(themeId: string | undefined | null): string {
  return `${PREFIX}${themeId || DEFAULT_ID}`;
}

/** Register (or replace) a Monaco theme keyed under `aethon-<id>`.
 *  Surface for `aethon.registerMonacoTheme(id, data)` so extensions
 *  + skills can supply their own Monaco palette in one call. The new
 *  data takes effect immediately if `id` is the active theme. */
export function registerMonacoTheme(
  id: string,
  data: monaco.editor.IStandaloneThemeData,
): void {
  if (!id || typeof id !== "string") return;
  if (!data || typeof data !== "object") return;
  REGISTRY.set(id, { data });
  try {
    monaco.editor.defineTheme(`${PREFIX}${id}`, data);
  } catch {
    // Monaco not ready — applyMonacoTheme retries on the next set.
  }
}

/** Apply the Monaco theme registered for the supplied Aethon id. */
export function applyMonacoTheme(themeId: string | undefined | null): void {
  seedBuiltins();
  defineAllInMonaco();
  const id = themeId || DEFAULT_ID;
  // If this id was overridden after the initial seed, re-define it so
  // Monaco's registry has the fresh data. Cheap; defineTheme is just a
  // map write inside Monaco.
  const record = REGISTRY.get(id);
  if (record) {
    try {
      monaco.editor.defineTheme(`${PREFIX}${id}`, record.data);
    } catch {
      /* not ready — fall through to setTheme */
    }
  }
  try {
    monaco.editor.setTheme(`${PREFIX}${id}`);
  } catch {
    // Should never happen post-define, but if it does, drop to
    // built-ins so the editor still paints something useful.
    try {
      const isDark = record?.data.base?.endsWith("dark") ?? true;
      monaco.editor.setTheme(isDark ? "vs-dark" : "vs");
    } catch {
      /* swallow */
    }
  }
}

/** Read the live `data-theme` attribute off the document root and
 *  apply the matching Monaco theme. Used by the canvas's mount-once
 *  and MutationObserver paths. */
export function syncMonacoThemeFromDom(): void {
  if (typeof document === "undefined") return;
  const id = document.documentElement.dataset.theme;
  applyMonacoTheme(id);
}

/** Test-only: reset registry + seed flag so each case starts clean. */
export const __testing = {
  reset(): void {
    REGISTRY.clear();
    bootSeeded = false;
    monacoDefined = false;
  },
};
