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
 * saved. The palette here is the same one in `src/styles/themes.css` for
 * each `:root[data-theme="…"]` block — both should move together.
 *
 * Overrides: extensions can replace any registered theme via
 * `aethon.registerMonacoTheme(id, data)` (mounted on `window.aethon`
 * by `useWindowApi`). The runtime registry is consulted first on
 * every `applyMonacoTheme(id)` call so a registration takes effect
 * without a reload.
 */

import { textmateThemeToMonacoTheme } from "@shikijs/monaco";

import {
  AETHON_SHIKI_THEMES,
  type AethonThemeId,
} from "./aethon-themes";
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

/** Theme definitions shared with Shiki. The Shiki bridge monkey-patches
 *  `monaco.editor.setTheme()` and only accepts loaded Shiki theme names,
 *  so the built-ins must be registered in both registries under the same
 *  `aethon-*` ids. */
const BUILTIN_THEMES: Record<AethonThemeId, monaco.editor.IStandaloneThemeData> =
  Object.fromEntries(
    AETHON_SHIKI_THEMES.map((theme) => [
      theme.name.replace(PREFIX, ""),
      textmateThemeToMonacoTheme(theme),
    ]),
  ) as Record<AethonThemeId, monaco.editor.IStandaloneThemeData>;

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
 *  can supply their own Monaco palette in one call. The new
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
