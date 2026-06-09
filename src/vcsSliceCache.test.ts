import { beforeEach, describe, expect, it, vi } from "vitest";

const { readStateMock, writeStateMock } = vi.hoisted(() => ({
  readStateMock: vi.fn(),
  writeStateMock: vi.fn(),
}));
vi.mock("./persist", () => ({
  readState: readStateMock,
  writeState: writeStateMock,
}));

import {
  __TEST__,
  getCachedVcsSlice,
  hydrateVcsSliceCache,
  putCachedVcsSlice,
} from "./vcsSliceCache";
import type { VcsSlice } from "./hooks/useVcsStatus";

function slice(root: string, branch = "main"): VcsSlice {
  return {
    root,
    branch,
    ahead: 1,
    behind: 0,
    dirty: true,
    ghAvailable: true,
    loading: false,
    changes: {
      total: 1,
      modified: 1,
      added: 0,
      deleted: 0,
      untracked: 0,
      renamed: 0,
      copied: 0,
      conflicted: 0,
      insertions: 3,
      deletions: 1,
      files: Array.from({ length: 60 }, (_, i) => ({
        path: `f${i}.ts`,
        status: "modified" as const,
      })),
    },
    pr: null,
    ci: {
      conclusion: "success",
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0,
      skipped: 0,
      checks: [{ name: "ci" } as never],
    },
  };
}

beforeEach(() => {
  __TEST__.reset();
  readStateMock.mockReset().mockResolvedValue("");
  writeStateMock.mockReset().mockResolvedValue(true);
});

describe("vcsSliceCache", () => {
  it("returns the last settled slice per workspace root", () => {
    putCachedVcsSlice("/a", slice("/a", "feat-a"));
    putCachedVcsSlice("/b", slice("/b", "feat-b"));
    expect(getCachedVcsSlice("/a")?.branch).toBe("feat-a");
    expect(getCachedVcsSlice("/b")?.branch).toBe("feat-b");
    expect(getCachedVcsSlice("/missing")).toBeUndefined();
  });

  it("evicts least-recently-used roots past the cap", () => {
    for (let i = 0; i < __TEST__.MAX_ENTRIES; i++) {
      putCachedVcsSlice(`/p${i}`, slice(`/p${i}`));
    }
    // Touch /p0 so /p1 becomes the oldest.
    getCachedVcsSlice("/p0");
    putCachedVcsSlice("/extra", slice("/extra"));

    expect(getCachedVcsSlice("/p0")).toBeTruthy();
    expect(getCachedVcsSlice("/p1")).toBeUndefined();
    expect(getCachedVcsSlice("/extra")).toBeTruthy();
  });

  it("persists slimmed entries (files capped, CI check details dropped)", async () => {
    putCachedVcsSlice("/a", slice("/a"));
    await __TEST__.flush();

    expect(writeStateMock).toHaveBeenCalledWith(
      __TEST__.CACHE_FILE,
      expect.any(String),
    );
    const written = JSON.parse(
      writeStateMock.mock.calls[0][1] as string,
    ) as {
      entries: Record<string, { slice: VcsSlice }>;
    };
    const persisted = written.entries["/a"].slice;
    expect(persisted.changes.files.length).toBeLessThanOrEqual(50);
    expect(persisted.changes.total).toBe(1);
    expect(persisted.ci?.checks).toEqual([]);
    expect(persisted.ci?.conclusion).toBe("success");
  });

  it("hydrates from disk without replacing fresher in-memory entries", async () => {
    readStateMock.mockResolvedValue(
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          "/disk": {
            updatedAt: new Date().toISOString(),
            slice: slice("/disk", "from-disk"),
          },
          "/live": {
            updatedAt: new Date().toISOString(),
            slice: slice("/live", "stale-disk"),
          },
        },
      }),
    );
    putCachedVcsSlice("/live", slice("/live", "fresh-live"));

    await hydrateVcsSliceCache();

    expect(getCachedVcsSlice("/disk")?.branch).toBe("from-disk");
    expect(getCachedVcsSlice("/live")?.branch).toBe("fresh-live");
  });

  it("drops stale and malformed disk entries", async () => {
    readStateMock.mockResolvedValue(
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          "/old": {
            updatedAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
            slice: slice("/old"),
          },
          "/mismatched": {
            updatedAt: new Date().toISOString(),
            slice: slice("/other-root"),
          },
        },
      }),
    );

    await hydrateVcsSliceCache();

    expect(getCachedVcsSlice("/old")).toBeUndefined();
    expect(getCachedVcsSlice("/mismatched")).toBeUndefined();
  });
});
