/**
 * Persistence for the user's "disabled extensions" list.
 *
 * One JSON file at `<userDir>/disabled-extensions.json` with the shape
 * `{ "disabled": ["name1", "name2"] }`. Loaded on bridge boot, rewritten
 * whenever the user toggles an extension via the sidebar context menu.
 *
 * The set lives on `state.disabledExtensions` and is consulted by the
 * loader (`extension-loader.ts`) to skip imports.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "./logger";

const FILE_NAME = "disabled-extensions.json";

export function disabledExtensionsFile(userDir: string): string {
  return join(userDir, FILE_NAME);
}

export async function loadDisabledExtensions(
  userDir: string,
): Promise<Set<string>> {
  const file = disabledExtensionsFile(userDir);
  try {
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text) as { disabled?: unknown };
    if (!parsed || !Array.isArray(parsed.disabled)) return new Set();
    const out = new Set<string>();
    for (const v of parsed.disabled) {
      if (typeof v === "string" && v.length > 0) out.add(v);
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    logger
      .scope("disabled-ext")
      .warn(`read ${file}: ${(err as Error).message}`);
    return new Set();
  }
}

export async function saveDisabledExtensions(
  userDir: string,
  disabled: Set<string>,
): Promise<void> {
  const file = disabledExtensionsFile(userDir);
  const payload = JSON.stringify(
    { disabled: [...disabled].sort() },
    null,
    2,
  );
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, payload + "\n", "utf8");
  } catch (err) {
    logger
      .scope("disabled-ext")
      .warn(`write ${file}: ${(err as Error).message}`);
  }
}
