/**
 * Disk-backed throttle cache for background git fetch attempts. This is
 * intentionally separate from `git-status.json`: status entries are user-facing
 * data, while this file only prevents fetch storms after reload/focus when a
 * repo is offline, auth prompts fail, or the app restarts repeatedly.
 */
import {
  createDebouncedMapWriter,
  readVersionedMap,
  writeVersionedMap,
  type VersionedMapStore,
} from "./versionedMapPersistence";

const CACHE_FILE = "git-fetch-attempts.json";
const SCHEMA_VERSION = 1;
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 400;

type PersistedAttempt = { lastAttemptedAt: string };

const store: VersionedMapStore<PersistedAttempt> = {
  file: CACHE_FILE,
  schemaVersion: SCHEMA_VERSION,
  decodeEntry: (_path, value) => {
    if (!value || typeof value !== "object") return undefined;
    const attemptedAt = (value as Partial<PersistedAttempt>).lastAttemptedAt;
    return typeof attemptedAt === "string"
      ? { lastAttemptedAt: attemptedAt }
      : undefined;
  },
  encodeEntry: (_path, entry) => entry,
};

export async function loadGitFetchAttempts(): Promise<Map<string, number>> {
  const cache = await readVersionedMap(store);
  const cutoff = Date.now() - STALE_AFTER_MS;
  const out = new Map<string, number>();
  for (const [path, entry] of cache) {
    const ts = Date.parse(entry.lastAttemptedAt);
    if (Number.isFinite(ts) && ts >= cutoff) out.set(path, ts);
  }
  return out;
}

const writer = createDebouncedMapWriter<number>({
  delayMs: WRITE_DEBOUNCE_MS,
  write: writeAttemptsNow,
});

export function persistGitFetchAttemptsDebounced(
  attempts: Map<string, number>,
): void {
  writer.schedule(attempts);
}

async function writeAttemptsNow(
  attempts: ReadonlyMap<string, number>,
): Promise<void> {
  const entries = new Map<string, PersistedAttempt>();
  for (const [path, ts] of attempts) {
    entries.set(path, { lastAttemptedAt: new Date(ts).toISOString() });
  }
  await writeVersionedMap(store, entries);
}

export async function flushPendingGitFetchAttemptsForTesting(): Promise<void> {
  await writer.flush();
}

export const __TEST__ = { CACHE_FILE, SCHEMA_VERSION, STALE_AFTER_MS };
