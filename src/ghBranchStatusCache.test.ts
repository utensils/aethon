/**
 * In-memory cache layer test. Mocks `@tauri-apps/api/core` so the
 * cache exercises its dedupe + TTL logic without needing a real
 * Tauri runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted to the top of the file, so the mock function has
// to live in a hoisted block too. `vi.hoisted` does exactly that.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  __clearCacheForTesting,
  __TEST__,
  getGhBranchStatus,
  refreshGhBranchStatus,
  type GhBranchStatus,
} from "./ghBranchStatusCache";

function makeStatus(over: Partial<GhBranchStatus> = {}): GhBranchStatus {
  return {
    ghAvailable: true,
    repo: "owner/repo",
    pushed: true,
    prs: [],
    ...over,
  };
}

describe("ghBranchStatusCache", () => {
  beforeEach(() => {
    __clearCacheForTesting();
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes once and returns the cached value on the second call", async () => {
    invokeMock.mockResolvedValueOnce(makeStatus());
    const a = await getGhBranchStatus("/p", "main");
    const b = await getGhBranchStatus("/p", "main");
    expect(a.repo).toBe("owner/repo");
    expect(b).toEqual(a);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent calls into one in-flight invocation", async () => {
    let resolveInner: ((s: GhBranchStatus) => void) | null = null;
    invokeMock.mockReturnValueOnce(
      new Promise<GhBranchStatus>((res) => {
        resolveInner = res;
      }),
    );
    const p1 = getGhBranchStatus("/p", "main");
    const p2 = getGhBranchStatus("/p", "main");
    resolveInner!(makeStatus());
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual(b);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("treats different (path, branch) pairs as distinct keys", async () => {
    invokeMock.mockResolvedValueOnce(makeStatus({ repo: "a/a" }));
    invokeMock.mockResolvedValueOnce(makeStatus({ repo: "b/b" }));
    const a = await getGhBranchStatus("/p", "main");
    const b = await getGhBranchStatus("/p", "dev");
    expect(a.repo).toBe("a/a");
    expect(b.repo).toBe("b/b");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after the TTL elapses for live repos", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValueOnce(makeStatus({ pushed: false }));
    invokeMock.mockResolvedValueOnce(makeStatus({ pushed: true }));
    const a = await getGhBranchStatus("/p", "main");
    expect(a.pushed).toBe(false);
    vi.advanceTimersByTime(__TEST__.TTL_MS + 1000);
    const b = await getGhBranchStatus("/p", "main");
    expect(b.pushed).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("uses the longer negative TTL when gh is unavailable", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValueOnce(makeStatus({ ghAvailable: false, repo: null }));
    invokeMock.mockResolvedValueOnce(makeStatus());
    await getGhBranchStatus("/p", "main");
    // Past the live TTL but still inside the negative TTL — should NOT refetch.
    vi.advanceTimersByTime(__TEST__.TTL_MS + 1000);
    await getGhBranchStatus("/p", "main");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // Cross the negative TTL — now it refetches.
    vi.advanceTimersByTime(__TEST__.NEGATIVE_TTL_MS);
    await getGhBranchStatus("/p", "main");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("refresh* drops the cache and re-invokes", async () => {
    invokeMock.mockResolvedValueOnce(makeStatus({ pushed: false }));
    invokeMock.mockResolvedValueOnce(makeStatus({ pushed: true }));
    const a = await getGhBranchStatus("/p", "main");
    expect(a.pushed).toBe(false);
    const b = await refreshGhBranchStatus("/p", "main");
    expect(b.pushed).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
