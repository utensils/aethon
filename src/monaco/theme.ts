/**
 * Aethon Monaco theme applier — the monaco-owning half of the theme
 * system. Loading THIS module means loading the monaco-editor chunk;
 * boot-path code registers through `theme-registry.ts` instead and this
 * module replays those registrations when it loads.
 *
 * Each Aethon CSS theme has a matching Monaco theme registered as
 * `aethon-<themeId>`. Built-ins are seeded set-if-absent at module load
 * (pre-Monaco is fine — `defineTheme` is safe to call before any editor
 * exists) so the editor never has a window where it falls back to
 * vanilla `vs` / `vs-dark` and looks out of place.
 *
 * Hard-coded rather than read from CSS vars on the fly: synthesising
 * from `getComputedStyle` introduced timing races on cold start
 * (theme persistence loaded after the canvas had already read the
 * default vars) and the reflection added more complexity than it
 * saved. The palette here is the same one in `src/styles/themes.css` for
 * each `:root[data-theme="…"]` block — both should move together.
 *
 * Overrides: extensions can replace any registered theme via
 * `aethon.registerMonacoTheme(id, data)` (mounted on `window.aethon`
 * by `useWindowApi`, backed by theme-registry). The registry is
 * consulted on every `applyMonacoTheme(id)` call so a registration
 * takes effect without a reload.
 */

import { textmateThemeToMonacoTheme } from "@shikijs/monaco";

import {
  AETHON_SHIKI_THEMES,
  type AethonThemeId,
} from "./aethon-themes";
import { monaco } from "./setup";
import {
  __testingRegistry,
  bindMonacoThemeApplier,
  getMonacoThemeRecord,
  monacoThemeFor,
  registerMonacoTheme,
  registeredMonacoThemes,
  seedMonacoTheme,
  type MonacoThemeData,
} from "./theme-registry";

/** Monaco theme id namespace used for the built-ins. */
const PREFIX = "aethon-";

let monacoDefined = false;

/** Default Aethon theme id for null/undefined input. */
const DEFAULT_ID = "ember";

/** Theme definitions shared with Shiki. The Shiki bridge monkey-patches
 *  `monaco.editor.setTheme()` and only accepts loaded Shiki theme names,
 *  so the built-ins must be registered in both registries under the same
 *  `aethon-*` ids. */
const BUILTIN_THEMES: Record<AethonThemeId, MonacoThemeData> =
  Object.fromEntries(
    AETHON_SHIKI_THEMES.map((theme) => [
      theme.name.replace(PREFIX, ""),
      textmateThemeToMonacoTheme(theme),
    ]),
  ) as Record<AethonThemeId, MonacoThemeData>;

function seedBuiltins(): void {
  for (const [id, data] of Object.entries(BUILTIN_THEMES)) {
    seedMonacoTheme(id, data);
  }
}

function defineAllInMonaco(): void {
  if (monacoDefined) return;
  try {
    for (const [id, record] of registeredMonacoThemes()) {
      monaco.editor.defineTheme(monacoThemeFor(id), record.data);
    }
    monacoDefined = true;
  } catch {
    // Monaco not ready yet — the next call will retry.
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
  const record = getMonacoThemeRecord(id);
  if (record) {
    try {
      monaco.editor.defineTheme(monacoThemeFor(id), record.data);
    } catch {
      /* not ready — fall through to setTheme */
    }
  }
  try {
    monaco.editor.setTheme(monacoThemeFor(id));
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

// Seed built-ins (set-if-absent — never clobber an override registered
// before this chunk loaded), then bind the registry's applier so
// registrations made from here on define into Monaco immediately, and
// early registrations replay now.
seedBuiltins();
bindMonacoThemeApplier({
  define(id, data) {
    try {
      monaco.editor.defineTheme(monacoThemeFor(id), data);
    } catch {
      // Monaco not ready — applyMonacoTheme retries on the next set.
    }
  },
  apply(themeId) {
    applyMonacoTheme(themeId);
  },
});

// Back-compat surface: consumers inside the editor chunk keep importing
// from here; boot-path consumers import theme-registry directly.
export { monacoThemeFor, registerMonacoTheme };

/** Test-only: reset registry + seed state so each case starts clean. */
export const __testing = {
  reset(): void {
    __testingRegistry.reset();
    monacoDefined = false;
    seedBuiltins();
  },
};
