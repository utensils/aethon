/**
 * Cache layer test. Mocks `@tauri-apps/api/core` so we exercise the
 * dedupe + TTL behaviour without a real Tauri runtime. Pattern mirrors
 * `ghBranchStatusCache.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  __clearCacheForTesting,
  __TEST__,
  getRepoOverview,
  peekRepoOverview,
  refreshRepoOverview,
  type GhRepoOverview,
} from "./ghRepoOverviewCache";

function makeOverview(over: Partial<GhRepoOverview> = {}): GhRepoOverview {
  return {
    ghAvailable: true,
    repo: "owner/repo",
    description: "test repo",
    url: "https://github.com/owner/repo",
    defaultBranch: "main",
    stargazerCount: 0,
    forkCount: 0,
    openIssuesCount: 0,
    openPrsCount: 0,
    pushedAt: null,
    ...over,
  };
}

describe("ghRepoOverviewCache", () => {
  beforeEach(() => {
    __clearCacheForTesting();
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes once and returns the cached value on the second call", async () => {
    invokeMock.mockResolvedValueOnce(makeOverview({ stargazerCount: 42 }));
    const a = await getRepoOverview("/p");
    const b = await getRepoOverview("/p");
    expect(a.stargazerCount).toBe(42);
    expect(b).toEqual(a);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent calls into one in-flight invocation", async () => {
    let resolveInner: ((o: GhRepoOverview) => void) | null = null;
    invokeMock.mockReturnValueOnce(
      new Promise<GhRepoOverview>((res) => {
        resolveInner = res;
      }),
    );
    const p1 = getRepoOverview("/p");
    const p2 = getRepoOverview("/p");
    resolveInner!(makeOverview());
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual(b);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("treats different project paths as distinct keys", async () => {
    invokeMock.mockResolvedValueOnce(makeOverview({ repo: "a/a" }));
    invokeMock.mockResolvedValueOnce(makeOverview({ repo: "b/b" }));
    const a = await getRepoOverview("/proj-a");
    const b = await getRepoOverview("/proj-b");
    expect(a.repo).toBe("a/a");
    expect(b.repo).toBe("b/b");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after the TTL elapses for live repos", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValueOnce(makeOverview({ openPrsCount: 2 }));
    invokeMock.mockResolvedValueOnce(makeOverview({ openPrsCount: 5 }));
    const a = await getRepoOverview("/p");
    expect(a.openPrsCount).toBe(2);
    vi.advanceTimersByTime(__TEST__.TTL_MS + 1000);
    const b = await getRepoOverview("/p");
    expect(b.openPrsCount).toBe(5);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("uses the longer negative TTL when gh is unavailable", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValueOnce(
      makeOverview({ ghAvailable: false, repo: null }),
    );
    invokeMock.mockResolvedValueOnce(makeOverview());
    await getRepoOverview("/p");
    // Past the live TTL but inside the negative TTL — should NOT refetch.
    vi.advanceTimersByTime(__TEST__.TTL_MS + 1000);
    await getRepoOverview("/p");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // Cross the negative TTL — now it refetches.
    vi.advanceTimersByTime(__TEST__.NEGATIVE_TTL_MS);
    await getRepoOverview("/p");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("refreshRepoOverview drops the cache and re-invokes", async () => {
    invokeMock.mockResolvedValueOnce(makeOverview({ openIssuesCount: 1 }));
    invokeMock.mockResolvedValueOnce(makeOverview({ openIssuesCount: 7 }));
    const a = await getRepoOverview("/p");
    expect(a.openIssuesCount).toBe(1);
    const b = await refreshRepoOverview("/p");
    expect(b.openIssuesCount).toBe(7);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("peekRepoOverview reads cached without fetching", async () => {
    expect(peekRepoOverview("/cold")).toBeNull();
    invokeMock.mockResolvedValueOnce(makeOverview({ forkCount: 11 }));
    await getRepoOverview("/warm");
    expect(peekRepoOverview("/warm")?.forkCount).toBe(11);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
