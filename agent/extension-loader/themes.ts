/**
 * Theme loading: validation, reserved-id guard, and the loose-file
 * theme reader for `~/.aethon/themes/*.json`. Both extension-supplied
 * themes (via `aethonApi.registerTheme`) and loose-file themes flow
 * through `normalizeTheme` before reaching the registry.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger";
import type { AethonAgentState, ThemeRecord } from "../state";

/** Theme ids the frontend ships built-in CSS for (see src/styles/themes.css).
 *  Extensions can't reuse these — the frontend always seeds the sidebar
 *  with these labels and the rule comes from the static stylesheet. */
export const RESERVED_THEME_IDS = new Set([
  "ember",
  "paper",
  "aether",
  "signature",
  "brink",
  "daylight",
  "mist",
  "nocturne",
]);

/** Validate theme metadata. The id is constrained to a slug so it's safe
 *  to embed in a CSS selector and a `<style>` element id; the variable
 *  names must look like CSS custom properties (`--*`). Variable values
 *  are passed through as-is — the frontend writes them via CSSOM
 *  `setProperty`, which silently rejects anything that would escape
 *  the declaration. Returns null when the input is too malformed to use
 *  (or collides with a reserved built-in id). */
export function normalizeTheme(input: unknown): ThemeRecord | null {
  if (!input || typeof input !== "object") return null;
  const t = input as { id?: unknown; label?: unknown; vars?: unknown };
  const id = typeof t.id === "string" ? t.id.trim() : "";
  if (!/^[A-Za-z][\w-]*$/.test(id)) return null;
  if (RESERVED_THEME_IDS.has(id)) return null;
  const label =
    typeof t.label === "string" && t.label.trim().length > 0
      ? t.label.trim()
      : id;
  const vars: Record<string, string> = {};
  if (t.vars && typeof t.vars === "object") {
    for (const [k, v] of Object.entries(t.vars as Record<string, unknown>)) {
      if (!/^--[A-Za-z0-9_-]+$/.test(k)) continue;
      if (typeof v !== "string") continue;
      vars[k] = v;
    }
  }
  return { id, label, vars };
}

/** Discover and load loose-file themes from `~/.aethon/themes/*.json`. */
export async function loadAethonThemeDirectory(
  state: AethonAgentState,
  api: { registerTheme: (theme: unknown) => unknown },
): Promise<void> {
  const dir = join(state.userDir, "themes");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger
        .scope("themes")
        .warn(`readdir ${dir}: ${(err as Error).message}`);
    }
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const text = await Bun.file(file).text();
      const parsed = JSON.parse(text) as unknown;
      // registerTheme handles validation internally — invalid input emits
      // a notice and resolves with {ok:false}.
      api.registerTheme(parsed);
      logger.scope("themes").info(`loaded ${name}`);
    } catch (err) {
      logger.scope("themes").warn(`${name}: ${(err as Error).message}`);
    }
  }
}
