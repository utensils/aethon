/**
 * Cache layer is pure I/O over `readState` / `writeState`. We mock the
 * persist module so the tests don't need Tauri, and verify the
 * round-trip + staleness drop + schema-version reject paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./persist", () => {
  let store = "";
  return {
    readState: vi.fn(() => Promise.resolve(store)),
    writeState: vi.fn((_name: string, content: string) => {
      store = content;
      return Promise.resolve(true);
    }),
    __reset() {
      store = "";
    },
    __peek() {
      return store;
    },
  };
});

import {
  flushPendingWriteForTesting,
  loadCachedStatuses,
  persistStatusesDebounced,
  __TEST__,
} from "./gitStatusCache";
import * as persist from "./persist";

const persistMock = persist as unknown as {
  readState: ReturnType<typeof vi.fn>;
  writeState: ReturnType<typeof vi.fn>;
  __reset: () => void;
  __peek: () => string;
};

describe("gitStatusCache", () => {
  beforeEach(() => {
    persistMock.__reset();
    persistMock.readState.mockClear();
    persistMock.writeState.mockClear();
  });
  afterEach(async () => {
    await flushPendingWriteForTesting();
  });

  it("returns empty map when the cache file is missing", async () => {
    const cached = await loadCachedStatuses();
    expect(cached.size).toBe(0);
  });

  it("round-trips a status through persist + load", async () => {
    const map = new Map([
      ["/a/foo", { branch: "main", dirty: false, ahead: 0, behind: 0 }],
      ["/b/bar", { branch: "dev", dirty: true, ahead: 2, behind: 1 }],
    ]);
    persistStatusesDebounced(map);
    await flushPendingWriteForTesting();
    expect(persistMock.writeState).toHaveBeenCalledTimes(1);

    const cached = await loadCachedStatuses();
    expect(cached.size).toBe(2);
    expect(cached.get("/a/foo")).toEqual({
      branch: "main",
      dirty: false,
      ahead: 0,
      behind: 0,
    });
    expect(cached.get("/b/bar")).toEqual({
      branch: "dev",
      dirty: true,
      ahead: 2,
      behind: 1,
    });
  });

  it("debounces multiple persist calls into one disk write", async () => {
    const map = new Map([["/p", { branch: "main" }]]);
    persistStatusesDebounced(map);
    persistStatusesDebounced(map);
    persistStatusesDebounced(map);
    await flushPendingWriteForTesting();
    expect(persistMock.writeState).toHaveBeenCalledTimes(1);
  });

  it("drops entries older than the staleness window", async () => {
    const staleTs = new Date(
      Date.now() - __TEST__.STALE_AFTER_MS - 60_000,
    ).toISOString();
    const file = {
      schemaVersion: __TEST__.SCHEMA_VERSION,
      entries: {
        "/fresh": {
          branch: "main",
          updatedAt: new Date().toISOString(),
        },
        "/stale": {
          branch: "old",
          updatedAt: staleTs,
        },
      },
    };
    await persist.writeState(__TEST__.CACHE_FILE, JSON.stringify(file));
    const cached = await loadCachedStatuses();
    expect(cached.has("/fresh")).toBe(true);
    expect(cached.has("/stale")).toBe(false);
  });

  it("rejects unknown schema versions and starts fresh", async () => {
    await persist.writeState(
      __TEST__.CACHE_FILE,
      JSON.stringify({
        schemaVersion: 999,
        entries: {
          "/legacy": { branch: "main", updatedAt: new Date().toISOString() },
        },
      }),
    );
    const cached = await loadCachedStatuses();
    expect(cached.size).toBe(0);
  });

  it("survives malformed JSON without throwing", async () => {
    await persist.writeState(__TEST__.CACHE_FILE, "{ not valid json");
    const cached = await loadCachedStatuses();
    expect(cached.size).toBe(0);
  });
});
