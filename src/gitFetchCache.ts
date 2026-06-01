/**
 * Disk-backed throttle cache for background git fetch attempts. This is
 * intentionally separate from `git-status.json`: status entries are user-facing
 * data, while this file only prevents fetch storms after reload/focus when a
 * repo is offline, auth prompts fail, or the app restarts repeatedly.
 */
import { readState, writeState } from "./persist";

const CACHE_FILE = "git-fetch-attempts.json";
const SCHEMA_VERSION = 1;
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 400;

interface CacheFile {
  schemaVersion: number;
  entries: Record<string, { lastAttemptedAt: string }>;
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
    const entries: CacheFile["entries"] = {};
    for (const [path, value] of Object.entries(obj.entries)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as { lastAttemptedAt?: unknown };
      if (typeof entry.lastAttemptedAt !== "string") continue;
      entries[path] = { lastAttemptedAt: entry.lastAttemptedAt };
    }
    return { schemaVersion: SCHEMA_VERSION, entries };
  } catch {
    return emptyCache();
  }
}

export async function loadGitFetchAttempts(): Promise<Map<string, number>> {
  const raw = await readState(CACHE_FILE);
  const cache = parseCache(raw);
  const cutoff = Date.now() - STALE_AFTER_MS;
  const out = new Map<string, number>();
  for (const [path, entry] of Object.entries(cache.entries)) {
    const ts = Date.parse(entry.lastAttemptedAt);
    if (Number.isFinite(ts) && ts >= cutoff) out.set(path, ts);
  }
  return out;
}

let pendingWriteTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWriteSnapshot: Map<string, number> | null = null;

export function persistGitFetchAttemptsDebounced(
  attempts: Map<string, number>,
): void {
  pendingWriteSnapshot = new Map(attempts);
  if (pendingWriteTimer) clearTimeout(pendingWriteTimer);
  pendingWriteTimer = setTimeout(() => {
    pendingWriteTimer = null;
    const snap = pendingWriteSnapshot;
    pendingWriteSnapshot = null;
    if (!snap) return;
    void writeAttemptsNow(snap);
  }, WRITE_DEBOUNCE_MS);
}

async function writeAttemptsNow(attempts: Map<string, number>): Promise<void> {
  const cache: CacheFile = { schemaVersion: SCHEMA_VERSION, entries: {} };
  for (const [path, ts] of attempts) {
    cache.entries[path] = { lastAttemptedAt: new Date(ts).toISOString() };
  }
  await writeState(CACHE_FILE, JSON.stringify(cache));
}

export async function flushPendingGitFetchAttemptsForTesting(): Promise<void> {
  if (pendingWriteTimer) {
    clearTimeout(pendingWriteTimer);
    pendingWriteTimer = null;
  }
  const snap = pendingWriteSnapshot;
  pendingWriteSnapshot = null;
  if (snap) await writeAttemptsNow(snap);
}

export const __TEST__ = { CACHE_FILE, SCHEMA_VERSION, STALE_AFTER_MS };
