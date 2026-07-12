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
import type { VcsSlice } from "./hooks/useVcsStatus";
import {
  createDebouncedMapWriter,
  readVersionedMap,
  writeVersionedMap,
  type VersionedMapStore,
} from "./versionedMapPersistence";

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

const store: VersionedMapStore<VcsSlice> = {
  file: CACHE_FILE,
  schemaVersion: SCHEMA_VERSION,
  decodeEntry: (root, value) => {
    if (!value || typeof value !== "object") return undefined;
    const entry = value as { updatedAt?: unknown; slice?: unknown };
    const ts =
      typeof entry.updatedAt === "string" ? Date.parse(entry.updatedAt) : NaN;
    if (!Number.isFinite(ts) || ts < Date.now() - STALE_AFTER_MS) {
      return undefined;
    }
    const slice = entry.slice;
    if (!slice || typeof slice !== "object") return undefined;
    const typedSlice = slice as VcsSlice;
    return typedSlice.root === root ? typedSlice : undefined;
  },
  encodeEntry: (_root, slice) => ({
    updatedAt: new Date().toISOString(),
    slice: slimForPersist(slice),
  }),
};

const writer = createDebouncedMapWriter<VcsSlice>({
  delayMs: WRITE_DEBOUNCE_MS,
  write: (snapshot) => writeVersionedMap(store, snapshot),
});

function persistDebounced(): void {
  writer.schedule(memory);
}

let hydrated: Promise<void> | null = null;

/** Load the on-disk cache into memory once. Disk entries never replace a
 *  live in-memory entry (the live one is fresher by construction). */
export function hydrateVcsSliceCache(): Promise<void> {
  hydrated ??= (async () => {
    const persisted = await readVersionedMap(store);
    for (const [root, slice] of persisted) {
      if (memory.has(root)) continue;
      memory.set(root, slice);
    }
    // A hand-edited / corrupted / pre-cap cache file must not blow past
    // the in-memory cap — apply the same eviction as putCachedVcsSlice.
    while (memory.size > MAX_ENTRIES) {
      const oldest = memory.keys().next().value;
      if (oldest === undefined) break;
      memory.delete(oldest);
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
    writer.cancel();
  },
  async flush(): Promise<void> {
    await writer.flush();
  },
};
