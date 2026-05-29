/**
 * In-memory CI-status cache test. Mocks `@tauri-apps/api/core` so the
 * dedupe + TTL logic is exercised without a Tauri runtime. Mirrors
 * `ghBranchStatusCache.test.ts` — the two caches share a shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  __clearCacheForTesting,
  __TEST__,
  getGhChecks,
  refreshGhChecks,
  type GhChecks,
} from "./ghChecksCache";

function makeChecks(over: Partial<GhChecks> = {}): GhChecks {
  return {
    ghAvailable: true,
    repo: "owner/repo",
    conclusion: "success",
    total: 3,
    passed: 3,
    failed: 0,
    pending: 0,
    skipped: 0,
    checks: [],
    ...over,
  };
}

describe("ghChecksCache", () => {
  beforeEach(() => {
    __clearCacheForTesting();
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes once and returns the cached value on the second call", async () => {
    invokeMock.mockResolvedValueOnce(makeChecks());
    const a = await getGhChecks("/p", "main");
    const b = await getGhChecks("/p", "main");
    expect(a.conclusion).toBe("success");
    expect(b).toEqual(a);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("gh_checks", {
      projectPath: "/p",
      branch: "main",
    });
  });

  it("dedupes concurrent calls into one in-flight invocation", async () => {
    let resolveInner: ((c: GhChecks) => void) | null = null;
    invokeMock.mockReturnValueOnce(
      new Promise<GhChecks>((res) => {
        resolveInner = res;
      }),
    );
    const p1 = getGhChecks("/p", "main");
    const p2 = getGhChecks("/p", "main");
    resolveInner!(makeChecks());
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual(b);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("treats different (path, branch) pairs as distinct keys", async () => {
    invokeMock.mockResolvedValueOnce(makeChecks({ repo: "a/a" }));
    invokeMock.mockResolvedValueOnce(makeChecks({ repo: "b/b" }));
    const a = await getGhChecks("/p", "main");
    const b = await getGhChecks("/p", "dev");
    expect(a.repo).toBe("a/a");
    expect(b.repo).toBe("b/b");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after the live TTL elapses", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValueOnce(makeChecks({ conclusion: "pending" }));
    invokeMock.mockResolvedValueOnce(makeChecks({ conclusion: "success" }));
    const a = await getGhChecks("/p", "main");
    expect(a.conclusion).toBe("pending");
    vi.advanceTimersByTime(__TEST__.TTL_MS + 1000);
    const b = await getGhChecks("/p", "main");
    expect(b.conclusion).toBe("success");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("uses the longer negative TTL when gh is unavailable", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValueOnce(
      makeChecks({ ghAvailable: false, repo: null, conclusion: null }),
    );
    invokeMock.mockResolvedValueOnce(makeChecks());
    await getGhChecks("/p", "main");
    // Past the live TTL but still inside the negative TTL — no refetch.
    vi.advanceTimersByTime(__TEST__.TTL_MS + 1000);
    await getGhChecks("/p", "main");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // Cross the negative TTL — now it refetches.
    vi.advanceTimersByTime(__TEST__.NEGATIVE_TTL_MS);
    await getGhChecks("/p", "main");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("refreshGhChecks drops the cache and re-invokes", async () => {
    invokeMock.mockResolvedValueOnce(makeChecks({ conclusion: "pending" }));
    invokeMock.mockResolvedValueOnce(makeChecks({ conclusion: "success" }));
    const a = await getGhChecks("/p", "main");
    expect(a.conclusion).toBe("pending");
    const b = await refreshGhChecks("/p", "main");
    expect(b.conclusion).toBe("success");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
