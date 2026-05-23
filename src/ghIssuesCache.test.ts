/**
 * Cache layer test for the issues feed. Mirrors the
 * `ghRepoOverviewCache.test.ts` pattern: vi.hoisted mock of `@tauri-apps/api/core`
 * so we exercise dedupe + TTL behaviour without a Tauri runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  __clearCacheForTesting,
  __TEST__,
  clearAllIssues,
  getIssueDetail,
  getIssues,
  peekIssues,
  refreshIssues,
  type GhIssue,
  type GhIssueDetail,
} from "./ghIssuesCache";

function makeIssue(over: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 1,
    title: "test",
    url: "https://example/issues/1",
    state: "OPEN",
    labels: [],
    updatedAt: null,
    author: null,
    comments: 0,
    ...over,
  };
}

describe("ghIssuesCache", () => {
  beforeEach(() => {
    __clearCacheForTesting();
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes once and returns the cached value on the second call", async () => {
    invokeMock.mockResolvedValueOnce([makeIssue({ number: 42 })]);
    const a = await getIssues("/p");
    const b = await getIssues("/p");
    expect(a[0].number).toBe(42);
    expect(b).toEqual(a);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent in-flight requests", async () => {
    let resolveCall: (v: GhIssue[]) => void = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveCall = res;
      }),
    );
    const a = getIssues("/p");
    const b = getIssues("/p");
    resolveCall([makeIssue()]);
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toEqual(resB);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty array and caches that on failure", async () => {
    invokeMock.mockRejectedValueOnce(new Error("gh not found"));
    const a = await getIssues("/p");
    expect(a).toEqual([]);
    const b = await getIssues("/p");
    expect(b).toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("re-invokes after the TTL expires", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue([makeIssue({ number: 1 })]);
    await getIssues("/p");
    vi.advanceTimersByTime(__TEST__.TTL_MS + 1);
    await getIssues("/p");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("refreshIssues busts the entry", async () => {
    invokeMock
      .mockResolvedValueOnce([makeIssue({ number: 1 })])
      .mockResolvedValueOnce([makeIssue({ number: 2 })]);
    const a = await getIssues("/p");
    const b = await refreshIssues("/p");
    expect(a[0].number).toBe(1);
    expect(b[0].number).toBe(2);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("clearAllIssues drops every entry", async () => {
    invokeMock.mockResolvedValue([makeIssue()]);
    await getIssues("/a");
    await getIssues("/b");
    clearAllIssues();
    expect(peekIssues("/a")).toBeNull();
    expect(peekIssues("/b")).toBeNull();
  });

  it("different limits are cached separately", async () => {
    invokeMock
      .mockResolvedValueOnce([makeIssue({ number: 1 })])
      .mockResolvedValueOnce([
        makeIssue({ number: 1 }),
        makeIssue({ number: 2 }),
      ]);
    const small = await getIssues("/p", 1);
    const big = await getIssues("/p", 50);
    expect(small).toHaveLength(1);
    expect(big).toHaveLength(2);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("getIssueDetail is uncached and forwards to gh_issue_view", async () => {
    const detail: GhIssueDetail = {
      number: 5,
      title: "x",
      url: "https://example/issues/5",
      body: "hello",
      author: "u",
    };
    invokeMock.mockResolvedValue(detail);
    const a = await getIssueDetail("/p", 5);
    const b = await getIssueDetail("/p", 5);
    expect(a).toEqual(detail);
    expect(b).toEqual(detail);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledWith("gh_issue_view", {
      projectPath: "/p",
      number: 5,
    });
  });
});
