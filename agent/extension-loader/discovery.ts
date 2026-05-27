/**
 * Out-of-band discovery: pi extensions that touch `globalThis.aethon`,
 * and persisted per-tab sessions under `<state.sessionsDir>/<tabId>/`.
 *
 * Neither flow imports the discovered files — pi loads pi extensions
 * itself; persisted-tab metadata is read via `readSessionMetadata`.
 * We just record presence so the sidebar can surface them.
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger";
import { readSessionMetadata } from "../session-history";
import type {
  AethonAgentState,
  DiscoveredTab,
  ExtensionSource,
} from "../state";

/** Discover pi extensions that touch `globalThis.aethon`. We grep each
 *  file for "globalThis.aethon" or "aethon.register" as a cheap signal of
 *  Aethon-awareness; non-Aethon pi extensions are skipped to keep the
 *  snapshot focused on UI-affecting code. */
export async function discoverPiAethonExtensions(
  registry: Map<string, ExtensionSource>,
): Promise<void> {
  const dir = join(homedir(), ".pi", "agent", "extensions");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger
        .scope("pi-discover")
        .warn(`readdir ${dir}: ${(err as Error).message}`);
    }
    return;
  }
  entries.sort();
  for (const name of entries) {
    if (!/\.(ts|js|mjs)$/.test(name)) continue;
    const file = join(dir, name);
    try {
      const text = await Bun.file(file).text();
      if (
        !text.includes("globalThis.aethon") &&
        !text.includes("aethon.register")
      ) {
        continue;
      }
      const display = name.replace(/\.(ts|js|mjs)$/, "");
      // Don't overwrite higher-precedence sources.
      if (!registry.has(display)) {
        registry.set(display, "pi-extension");
      }
    } catch {
      // Unreadable file — skip silently. Pi will surface its own load
      // error if the file is truly broken at import time.
    }
  }
}

/** Discover persisted per-tab sessions on disk under SESSIONS_DIR/<tabId>/. */
export async function discoverPersistedTabs(
  state: AethonAgentState,
): Promise<DiscoveredTab[]> {
  let entries: string[];
  try {
    entries = await readdir(state.sessionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger
        .scope("tabs")
        .warn(`readdir ${state.sessionsDir}: ${(err as Error).message}`);
    }
    return [];
  }
  const results: DiscoveredTab[] = [];
  for (const name of entries) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) continue;
    const dir = join(state.sessionsDir, name);
    try {
      const meta = await readSessionMetadata(dir);
      if (meta) results.push({ tabId: name, ...meta });
    } catch {
      /* skip — best effort */
    }
  }
  results.sort((a, b) => b.lastModified - a.lastModified);
  return results;
}
