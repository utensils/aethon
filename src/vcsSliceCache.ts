/**
 * Warm per-workspace cache for the `/vcs` slice. Switching workspaces
 * previously reset `/vcs` to an empty loading shell and refetched
 * everything (git status, file breakdown, diff stat, gh PR/CI) from
 * scratch — the header cluster and source-control panel blanked out for
 * the whole round-trip. This cache keeps the last settled slice per
 * workspace root so a switch paints the last-known state instantly
 * (marked `loading: true`) while the background tick reconciles.
 *
 * Two layers:
 *   - in-memory Map (LRU, capped) — the hot path on workspace switches.
 *   - `~/.aethon/vcs-status.json` (debounced) — cold-start hydration, so
 *     the first paint after a relaunch shows last-known branch/PR/CI.
 *
 * Persisted entries are slimmed: the per-file change list is capped and
 * the CI check-run details are dropped (counts + conclusion stay); both
 * re-materialize on the first live tick.
 */
import { readState, writeState } from "./persist";
import type { VcsSlice } from "./hooks/useVcsStatus";

const CACHE_FILE = "vcs-status.json";
const SCHEMA_VERSION = 1;
/** Workspaces beyond this are evicted oldest-touched-first. */
const MAX_ENTRIES = 32;
/** Persisted entries older than this are dropped on load. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 1_000;
/** Cap the persisted per-file list (the live slice caps at 200). */
const MAX_PERSISTED_FILES = 50;

const memory = new Map<string, VcsSlice>();

/** Last settled slice for a workspace root, or undefined. Touches the
 *  entry for LRU purposes. */
export function getCachedVcsSlice(root: string): VcsSlice | undefined {
  const hit = memory.get(root);
  if (hit) {
    memory.delete(root);
    memory.set(root, hit);
  }
  return hit;
}

/** Record a settled slice for its root and schedule persistence. */
export function putCachedVcsSlice(root: string, slice: VcsSlice): void {
  memory.delete(root);
  memory.set(root, slice);
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  persistDebounced();
}

interface PersistedEntry {
  updatedAt: string;
  slice: VcsSlice;
}

interface CacheFile {
  schemaVersion: number;
  entries: Record<string, PersistedEntry>;
}

function slimForPersist(slice: VcsSlice): VcsSlice {
  return {
    ...slice,
    loading: false,
    changes: {
      ...slice.changes,
      files: slice.changes.files.slice(0, MAX_PERSISTED_FILES),
    },
    ci: slice.ci ? { ...slice.ci, checks: [] } : null,
  };
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function persistDebounced(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeNow();
  }, WRITE_DEBOUNCE_MS);
}

async function writeNow(): Promise<void> {
  const now = new Date().toISOString();
  const cache: CacheFile = { schemaVersion: SCHEMA_VERSION, entries: {} };
  for (const [root, slice] of memory) {
    cache.entries[root] = { updatedAt: now, slice: slimForPersist(slice) };
  }
  await writeState(CACHE_FILE, JSON.stringify(cache));
}

let hydrated: Promise<void> | null = null;

/** Load the on-disk cache into memory once. Disk entries never replace a
 *  live in-memory entry (the live one is fresher by construction). */
export function hydrateVcsSliceCache(): Promise<void> {
  hydrated ??= (async () => {
    const raw = await readState(CACHE_FILE);
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as { schemaVersion?: number; entries?: unknown };
    if (obj.schemaVersion !== SCHEMA_VERSION) return;
    if (!obj.entries || typeof obj.entries !== "object") return;
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [root, value] of Object.entries(obj.entries)) {
      if (memory.has(root)) continue;
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<PersistedEntry>;
      const ts = typeof entry.updatedAt === "string" ? Date.parse(entry.updatedAt) : NaN;
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const slice = entry.slice;
      if (!slice || typeof slice !== "object" || slice.root !== root) continue;
      memory.set(root, slice);
    }
  })();
  return hydrated;
}

/** Test hooks — reset module state and flush pending writes. */
export const __TEST__ = {
  CACHE_FILE,
  MAX_ENTRIES,
  reset(): void {
    memory.clear();
    hydrated = null;
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
  },
  async flush(): Promise<void> {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    await writeNow();
  },
};
