/**
 * Monaco-free half of the Aethon Monaco theme system.
 *
 * `windowApi` (always loaded at boot) and extension registration paths
 * import THIS module, so registering a Monaco theme never pulls the
 * multi-megabyte monaco-editor chunk into the boot bundle. The applier
 * half (`theme.ts`, which lives inside the editor chunk) binds itself
 * here when that chunk loads and replays anything registered early.
 *
 * Before the applier binds, `applyMonacoThemeIfLoaded` is a no-op by
 * design: no editor exists yet, and the editor canvas applies the
 * active theme on its own mount.
 */

import type * as monacoTypes from "monaco-editor";

export type MonacoThemeData = monacoTypes.editor.IStandaloneThemeData;

/** Monaco theme id namespace shared with the applier. */
const PREFIX = "aethon-";

/** Default Aethon theme id for null/undefined input. Matches the
 *  initial value of `:root[data-theme]` in `useBootConfig`. */
const DEFAULT_ID = "ember";

interface ThemeRecord {
  data: MonacoThemeData;
}

/** Live registry. Built-ins are seeded by theme.ts (set-if-absent so a
 *  user/extension override registered before the editor chunk loads is
 *  never clobbered); overrides land here via `registerMonacoTheme`. */
const REGISTRY = new Map<string, ThemeRecord>();

export interface MonacoThemeApplier {
  define(id: string, data: MonacoThemeData): void;
  apply(themeId: string | undefined | null): void;
}

let applier: MonacoThemeApplier | null = null;

/** Called by theme.ts at module load (i.e. when monaco exists). Replays
 *  every record registered before the editor chunk loaded. */
export function bindMonacoThemeApplier(next: MonacoThemeApplier): void {
  applier = next;
  for (const [id, record] of REGISTRY) {
    next.define(id, record.data);
  }
}

/** Stable Monaco theme id for an Aethon theme id. */
export function monacoThemeFor(themeId: string | undefined | null): string {
  return `${PREFIX}${themeId || DEFAULT_ID}`;
}

/** Register (or replace) a Monaco theme keyed under `aethon-<id>`.
 *  Surface for `aethon.registerMonacoTheme(id, data)`. Takes effect in
 *  Monaco immediately when the editor chunk is loaded; otherwise the
 *  applier replays it on bind. */
export function registerMonacoTheme(id: string, data: MonacoThemeData): void {
  if (!id || typeof id !== "string") return;
  if (!data || typeof data !== "object") return;
  REGISTRY.set(id, { data });
  applier?.define(id, data);
}

/** Seed a built-in without clobbering an earlier override. */
export function seedMonacoTheme(id: string, data: MonacoThemeData): void {
  if (REGISTRY.has(id)) return;
  REGISTRY.set(id, { data });
}

export function getMonacoThemeRecord(id: string): ThemeRecord | undefined {
  return REGISTRY.get(id);
}

export function registeredMonacoThemes(): ReadonlyMap<string, ThemeRecord> {
  return REGISTRY;
}

/** Apply now if the editor chunk has loaded; no-op before that. */
export function applyMonacoThemeIfLoaded(
  themeId: string | undefined | null,
): void {
  applier?.apply(themeId);
}

/** Test-only: clear records (the applier binding survives — module
 *  identity is process-wide under vitest too). */
export const __testingRegistry = {
  reset(): void {
    REGISTRY.clear();
  },
};
