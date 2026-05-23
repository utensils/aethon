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
import { readState, writeState } from "./persist";
import type { GitStatus } from "./hooks/useProjects";

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

interface CacheFile {
  schemaVersion: number;
  entries: Record<string, CachedEntry>;
}

function emptyCache(): CacheFile {
  return { schemaVersion: SCHEMA_VERSION, entries: {} };
}

function parseCache(raw: string): CacheFile {
  if (!raw) return emptyCache();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyCache();
    const obj = parsed as { schemaVersion?: number; entries?: unknown };
    if (obj.schemaVersion !== SCHEMA_VERSION) return emptyCache();
    if (!obj.entries || typeof obj.entries !== "object") return emptyCache();
    const entries: Record<string, CachedEntry> = {};
    for (const [path, value] of Object.entries(obj.entries)) {
      if (!value || typeof value !== "object") continue;
      const e = value as Partial<CachedEntry>;
      if (typeof e.updatedAt !== "string") continue;
      entries[path] = {
        branch: typeof e.branch === "string" ? e.branch : undefined,
        dirty: typeof e.dirty === "boolean" ? e.dirty : undefined,
        ahead: typeof e.ahead === "number" ? e.ahead : undefined,
        behind: typeof e.behind === "number" ? e.behind : undefined,
        updatedAt: e.updatedAt,
      };
    }
    return { schemaVersion: SCHEMA_VERSION, entries };
  } catch {
    return emptyCache();
  }
}

/** Read + parse the on-disk cache. Drops entries older than the
 *  staleness window so callers never have to think about it. Returns
 *  a plain Map keyed by absolute project path. */
export async function loadCachedStatuses(): Promise<Map<string, GitStatus>> {
  const raw = await readState(CACHE_FILE);
  const cache = parseCache(raw);
  const cutoff = Date.now() - STALE_AFTER_MS;
  const out = new Map<string, GitStatus>();
  for (const [path, entry] of Object.entries(cache.entries)) {
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

let pendingWriteTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWriteSnapshot: Map<string, GitStatus> | null = null;

/** Schedule a debounced write of the current cache snapshot. Multiple
 *  calls within WRITE_DEBOUNCE_MS collapse into one disk write of the
 *  latest snapshot, so a burst across 16 projects writes once. */
export function persistStatusesDebounced(statuses: Map<string, GitStatus>): void {
  // Clone synchronously — the caller's Map may keep mutating before
  // the debounce timer fires, and we want the snapshot frozen at the
  // moment persistence was requested.
  pendingWriteSnapshot = new Map(statuses);
  if (pendingWriteTimer) clearTimeout(pendingWriteTimer);
  pendingWriteTimer = setTimeout(() => {
    pendingWriteTimer = null;
    const snap = pendingWriteSnapshot;
    pendingWriteSnapshot = null;
    if (!snap) return;
    void writeStatusesNow(snap);
  }, WRITE_DEBOUNCE_MS);
}

async function writeStatusesNow(statuses: Map<string, GitStatus>): Promise<void> {
  const now = new Date().toISOString();
  const cache: CacheFile = { schemaVersion: SCHEMA_VERSION, entries: {} };
  for (const [path, status] of statuses) {
    cache.entries[path] = {
      branch: status.branch,
      dirty: status.dirty,
      ahead: status.ahead,
      behind: status.behind,
      updatedAt: now,
    };
  }
  await writeState(CACHE_FILE, JSON.stringify(cache));
}

/** Exposed for tests — flush any pending write immediately. */
export async function flushPendingWriteForTesting(): Promise<void> {
  if (pendingWriteTimer) {
    clearTimeout(pendingWriteTimer);
    pendingWriteTimer = null;
  }
  const snap = pendingWriteSnapshot;
  pendingWriteSnapshot = null;
  if (snap) await writeStatusesNow(snap);
}

/** Exposed for tests — internal constants. */
export const __TEST__ = { CACHE_FILE, SCHEMA_VERSION, STALE_AFTER_MS };
