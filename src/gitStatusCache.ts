/**
 * Disk-backed cache for per-project git status. Persisted to
 * `~/.aethon/git-status.json` so the sidebar's branch / dirty / ahead
 * / behind chips paint instantly on cold start with last-known values,
 * then refresh in the background.
 *
 * Cache entries carry an `updatedAt` ISO timestamp. Stale entries
 * (older than STALE_AFTER_MS) are dropped at load time so a long-idle
 * project that's been deleted out from under us doesn't keep a stale
 * chip alive forever.
 *
 * Writes are debounced so a burst of refreshes across 16 projects
 * collapses into a single disk write at the tail of the batch.
 */
import type { GitStatus } from "./hooks/useProjects";
import {
  createDebouncedMapWriter,
  readVersionedMap,
  writeVersionedMap,
  type VersionedMapStore,
} from "./versionedMapPersistence";

const CACHE_FILE = "git-status.json";
const SCHEMA_VERSION = 1;
/** Cache entries older than this are treated as missing on load. 7
 *  days strikes a balance between "instant paint after a week away"
 *  and "don't keep stale chips for deleted projects forever". */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 400;

interface CachedEntry extends GitStatus {
  updatedAt: string;
}

const store: VersionedMapStore<CachedEntry> = {
  file: CACHE_FILE,
  schemaVersion: SCHEMA_VERSION,
  decodeEntry: (_path, value) => {
    if (!value || typeof value !== "object") return undefined;
    const entry = value as Partial<CachedEntry>;
    if (typeof entry.updatedAt !== "string") return undefined;
    return {
      branch: typeof entry.branch === "string" ? entry.branch : undefined,
      dirty: typeof entry.dirty === "boolean" ? entry.dirty : undefined,
      ahead: typeof entry.ahead === "number" ? entry.ahead : undefined,
      behind: typeof entry.behind === "number" ? entry.behind : undefined,
      updatedAt: entry.updatedAt,
    };
  },
  encodeEntry: (_path, entry) => entry,
};

/** Read + parse the on-disk cache. Drops entries older than the
 *  staleness window so callers never have to think about it. Returns
 *  a plain Map keyed by absolute project path. */
export async function loadCachedStatuses(): Promise<Map<string, GitStatus>> {
  const cache = await readVersionedMap(store);
  const cutoff = Date.now() - STALE_AFTER_MS;
  const out = new Map<string, GitStatus>();
  for (const [path, entry] of cache) {
    const ts = Date.parse(entry.updatedAt);
    if (Number.isFinite(ts) && ts >= cutoff) {
      out.set(path, {
        branch: entry.branch,
        dirty: entry.dirty,
        ahead: entry.ahead,
        behind: entry.behind,
      });
    }
  }
  return out;
}

const writer = createDebouncedMapWriter<GitStatus>({
  delayMs: WRITE_DEBOUNCE_MS,
  write: writeStatusesNow,
});

/** Schedule a debounced write of the current cache snapshot. Multiple
 *  calls within WRITE_DEBOUNCE_MS collapse into one disk write of the
 *  latest snapshot, so a burst across 16 projects writes once. */
export function persistStatusesDebounced(statuses: Map<string, GitStatus>): void {
  // Clone synchronously — the caller's Map may keep mutating before
  // the debounce timer fires, and we want the snapshot frozen at the
  // moment persistence was requested.
  writer.schedule(statuses);
}

async function writeStatusesNow(
  statuses: ReadonlyMap<string, GitStatus>,
): Promise<void> {
  const now = new Date().toISOString();
  const entries = new Map<string, CachedEntry>();
  for (const [path, status] of statuses) {
    entries.set(path, {
      branch: status.branch,
      dirty: status.dirty,
      ahead: status.ahead,
      behind: status.behind,
      updatedAt: now,
    });
  }
  await writeVersionedMap(store, entries);
}

/** Exposed for tests — flush any pending write immediately. */
export async function flushPendingWriteForTesting(): Promise<void> {
  await writer.flush();
}

/** Exposed for tests — internal constants. */
export const __TEST__ = { CACHE_FILE, SCHEMA_VERSION, STALE_AFTER_MS };
