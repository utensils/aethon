/**
 * Persistence for the user's "disabled extensions" list.
 *
 * One JSON file at `<userDir>/disabled-extensions.json` with the shape
 * `{ "disabled": [{ "name": "...", "source": "...", "projectRoot": "..." }] }`.
 * Loaded on bridge boot, rewritten whenever the user toggles an extension
 * via the sidebar context menu.
 *
 * Legacy format `{ "disabled": ["name1", "name2"] }` is still accepted on
 * read — entries without metadata are treated as global (always shown in
 * the sidebar regardless of active project). Once the user toggles a
 * legacy entry the bridge captures its source/projectRoot from the live
 * loader registries and rewrites the file in the enriched format.
 *
 * The names live on `state.disabledExtensions` (consulted by the loader
 * to skip imports) and the metadata lives on
 * `state.disabledExtensionMeta` (consulted by the frontend to scope
 * project-directory rows to the right project).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "./logger";
import type { ExtensionSource } from "./state";

const FILE_NAME = "disabled-extensions.json";

export interface DisabledExtensionMeta {
  source: ExtensionSource;
  projectRoot?: string;
}

export interface DisabledExtensionsSnapshot {
  names: Set<string>;
  meta: Map<string, DisabledExtensionMeta>;
}

const VALID_SOURCES: ReadonlySet<ExtensionSource> = new Set([
  "directory",
  "project-directory",
  "extension-package",
  "pi-extension",
]);

export function disabledExtensionsFile(userDir: string): string {
  return join(userDir, FILE_NAME);
}

export async function loadDisabledExtensionsSnapshot(
  userDir: string,
): Promise<DisabledExtensionsSnapshot> {
  const file = disabledExtensionsFile(userDir);
  const empty: DisabledExtensionsSnapshot = {
    names: new Set(),
    meta: new Map(),
  };
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty;
    logger
      .scope("disabled-ext")
      .warn(`read ${file}: ${(err as Error).message}`);
    return empty;
  }
  let parsed: { disabled?: unknown };
  try {
    parsed = JSON.parse(text) as { disabled?: unknown };
  } catch (err) {
    logger
      .scope("disabled-ext")
      .warn(`parse ${file}: ${(err as Error).message}`);
    return empty;
  }
  if (!parsed || !Array.isArray(parsed.disabled)) return empty;
  const names = new Set<string>();
  const meta = new Map<string, DisabledExtensionMeta>();
  for (const v of parsed.disabled) {
    if (typeof v === "string") {
      if (v.length > 0) names.add(v);
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const entry = v as { name?: unknown; source?: unknown; projectRoot?: unknown };
    if (typeof entry.name !== "string" || entry.name.length === 0) continue;
    names.add(entry.name);
    const source =
      typeof entry.source === "string" && VALID_SOURCES.has(entry.source as ExtensionSource)
        ? (entry.source as ExtensionSource)
        : undefined;
    if (source) {
      const projectRoot =
        typeof entry.projectRoot === "string" && entry.projectRoot.length > 0
          ? entry.projectRoot
          : undefined;
      meta.set(entry.name, projectRoot ? { source, projectRoot } : { source });
    }
  }
  return { names, meta };
}

/** Legacy name-only loader retained for tests that don't care about
 *  metadata. Prefer `loadDisabledExtensionsSnapshot` in new code. */
export async function loadDisabledExtensions(
  userDir: string,
): Promise<Set<string>> {
  const snapshot = await loadDisabledExtensionsSnapshot(userDir);
  return snapshot.names;
}

/** Persist the disabled list. Throws on failure so the caller can
 *  refuse the toggle (revert in-memory, surface an error) instead of
 *  silently losing the user's intent — a swallowed write means a
 *  successful-looking toast followed by a bridge reload that re-loads
 *  the extension because the on-disk file still says "enabled". */
export async function saveDisabledExtensionsSnapshot(
  userDir: string,
  snapshot: DisabledExtensionsSnapshot,
): Promise<void> {
  const file = disabledExtensionsFile(userDir);
  const entries = [...snapshot.names].sort().map((name) => {
    const m = snapshot.meta.get(name);
    if (!m) return { name };
    return m.projectRoot
      ? { name, source: m.source, projectRoot: m.projectRoot }
      : { name, source: m.source };
  });
  const payload = JSON.stringify({ disabled: entries }, null, 2);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, payload + "\n", "utf8");
  } catch (err) {
    logger
      .scope("disabled-ext")
      .warn(`write ${file}: ${(err as Error).message}`);
    throw err;
  }
}

/** Back-compat shim — callers that only have names (e.g. older tests)
 *  persist with empty metadata. Prefer `saveDisabledExtensionsSnapshot`. */
export async function saveDisabledExtensions(
  userDir: string,
  disabled: Set<string>,
): Promise<void> {
  await saveDisabledExtensionsSnapshot(userDir, {
    names: new Set(disabled),
    meta: new Map(),
  });
}
