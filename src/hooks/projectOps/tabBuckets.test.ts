import type { Dispatch, SetStateAction } from "react";
import { describe, it, expect } from "vitest";
import { makeEmptyTab, type Tab } from "../../types/tab";
import { switchProjectBucket } from "./tabBuckets";
import type { TabBucket } from "./types";

function agentTab(id: string, projectId: string, cwd: string): Tab {
  return {
    ...makeEmptyTab(id, id, projectId, "agent"),
    cwd,
    messages: [{ id: `${id}-m`, role: "user", text: id }],
  };
}

function makeHarness(initial: Record<string, unknown>) {
  let state = initial;
  const stateRef = { current: state };
  const setState: Dispatch<SetStateAction<Record<string, unknown>>> = (
    update,
  ) => {
    state = typeof update === "function" ? update(state) : update;
    stateRef.current = state;
  };
  const tabBucketsRef = { current: new Map<string, TabBucket>() };
  const deps = {
    setState,
    stateRef,
    tabBucketsRef,
    buildProjectsMirror: () => ({}),
    dispatchTerminalReplay: () => {},
  };
  return { deps, tabBucketsRef, setState, get: () => state };
}

describe("switchProjectBucket", () => {
  it("keeps each workspace's tabs separate and restores the last-active tab", () => {
    const tabP = agentTab("p-main", "P", "/P");
    const h = makeHarness({ tabs: [tabP], activeTabId: "p-main" });

    // P-main -> worktree A (empty bucket -> overview).
    switchProjectBucket(h.deps, "P", "P::worktree::A");
    expect(h.tabBucketsRef.current.get("P")?.tabs.map((t) => t.id)).toEqual([
      "p-main",
    ]);
    expect((h.get().tabs as Tab[]).length).toBe(0);

    // Open a session in worktree A.
    const tabA = agentTab("a1", "P", "/P/A");
    h.deps.setState((prev) => ({ ...prev, tabs: [tabA], activeTabId: "a1" }));

    // A -> B.
    switchProjectBucket(h.deps, "P::worktree::A", "P::worktree::B");
    expect(
      h.tabBucketsRef.current.get("P::worktree::A")?.tabs.map((t) => t.id),
    ).toEqual(["a1"]);

    // Open a session in worktree B.
    const tabB = agentTab("b1", "P", "/P/B");
    h.deps.setState((prev) => ({ ...prev, tabs: [tabB], activeTabId: "b1" }));

    // B -> back to P-main: should restore p-main, not the landing.
    const restored = switchProjectBucket(h.deps, "P::worktree::B", "P");
    expect(restored).toBe("p-main");
    expect((h.get().tabs as Tab[]).map((t) => t.id)).toEqual(["p-main"]);
    expect(h.get().activeTabId).toBe("p-main");

    // No cross-contamination: each worktree bucket kept only its own tab.
    expect(
      h.tabBucketsRef.current.get("P::worktree::A")?.tabs.map((t) => t.id),
    ).toEqual(["a1"]);
    expect(
      h.tabBucketsRef.current.get("P::worktree::B")?.tabs.map((t) => t.id),
    ).toEqual(["b1"]);
  });

  it("clears a stale landing override when restoring an active tab", () => {
    const tabA = agentTab("a1", "P", "/P/A");
    const h = makeHarness({
      tabs: [],
      activeTabId: undefined,
      landing: { kind: "worktree", worktreeId: "B" },
      messages: [{ id: "stale", role: "user", text: "stale landing" }],
      draft: "stale draft",
    });
    h.tabBucketsRef.current.set("P::worktree::A", {
      tabs: [tabA],
      activeTabId: "a1",
    });

    const restored = switchProjectBucket(
      h.deps,
      "P::worktree::B",
      "P::worktree::A",
    );

    expect(restored).toBe("a1");
    expect(h.get().activeTabId).toBe("a1");
    expect(h.get().landing).toBeNull();
    expect(h.get().messages).toEqual(tabA.messages);
    expect(h.get().draft).toBe(tabA.draft);
  });

  it("preserves landing when switching to an empty workspace", () => {
    const h = makeHarness({
      tabs: [],
      activeTabId: undefined,
      landing: { kind: "worktree", worktreeId: "B" },
    });

    switchProjectBucket(h.deps, "P::worktree::B", "P::worktree::A");

    expect(h.get().activeTabId).toBeUndefined();
    expect(h.get().tabs).toEqual([]);
    expect(h.get().landing).toEqual({ kind: "worktree", worktreeId: "B" });
  });

  it("mirrors non-active buckets into state.persistedTabBuckets for persistence", () => {
    const tabP = agentTab("p-main", "P", "/P");
    const h = makeHarness({ tabs: [tabP], activeTabId: "p-main" });

    switchProjectBucket(h.deps, "P", "P::worktree::A");
    const tabA = agentTab("a1", "P", "/P/A");
    h.deps.setState((prev) => ({ ...prev, tabs: [tabA], activeTabId: "a1" }));
    switchProjectBucket(h.deps, "P::worktree::A", "P");

    // Active workspace ("P") lives in state.tabs, so it's excluded from the
    // mirror; the backgrounded worktree A is included with its active tab.
    const mirror = h.get().persistedTabBuckets as Record<
      string,
      { tabs: Tab[]; activeTabId?: string }
    >;
    expect(Object.keys(mirror)).toEqual(["P::worktree::A"]);
    expect(mirror["P::worktree::A"].activeTabId).toBe("a1");
    expect(mirror["P::worktree::A"].tabs.map((t) => t.id)).toEqual(["a1"]);
  });
});
