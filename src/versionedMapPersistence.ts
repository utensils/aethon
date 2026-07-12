import { readState, writeState } from "./persist";

type VersionedEntries = {
  schemaVersion: number;
  entries: Record<string, unknown>;
};

export type VersionedMapStore<T> = {
  file: string;
  schemaVersion: number;
  decodeEntry: (key: string, value: unknown) => T | undefined;
  encodeEntry: (key: string, value: T) => unknown;
};

/** Read a versioned record from state, dropping invalid entries independently. */
export async function readVersionedMap<T>(
  store: VersionedMapStore<T>,
): Promise<Map<string, T>> {
  return parseVersionedMap(await readState(store.file), store);
}

export function parseVersionedMap<T>(
  raw: string,
  store: Pick<VersionedMapStore<T>, "schemaVersion" | "decodeEntry">,
): Map<string, T> {
  const out = new Map<string, T>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isVersionedEntries(parsed, store.schemaVersion)) return out;
  for (const [key, rawEntry] of Object.entries(parsed.entries)) {
    const entry = store.decodeEntry(key, rawEntry);
    if (entry !== undefined) out.set(key, entry);
  }
  return out;
}

export async function writeVersionedMap<T>(
  store: VersionedMapStore<T>,
  entries: ReadonlyMap<string, T>,
): Promise<void> {
  const persisted: VersionedEntries = {
    schemaVersion: store.schemaVersion,
    entries: {},
  };
  for (const [key, value] of entries) {
    persisted.entries[key] = store.encodeEntry(key, value);
  }
  await writeState(store.file, JSON.stringify(persisted));
}

export function createDebouncedMapWriter<T>(options: {
  delayMs: number;
  write: (snapshot: ReadonlyMap<string, T>) => Promise<void>;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let snapshot: Map<string, T> | null = null;

  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    const pending = snapshot;
    snapshot = null;
    if (pending) await options.write(pending);
  };

  return {
    schedule(entries: ReadonlyMap<string, T>): void {
      snapshot = new Map(entries);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void flush().catch(() => {
          // Scheduled persistence is best-effort; explicit flush() callers
          // still receive failures when they need to surface them.
        });
      }, options.delayMs);
    },
    flush,
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      snapshot = null;
    },
  };
}

function isVersionedEntries(
  value: unknown,
  schemaVersion: number,
): value is VersionedEntries {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VersionedEntries>;
  return (
    candidate.schemaVersion === schemaVersion &&
    !!candidate.entries &&
    typeof candidate.entries === "object" &&
    !Array.isArray(candidate.entries)
  );
}
