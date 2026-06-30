// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeEmptyTab, type Tab } from "../types/tab";
import { useTabBucketHydration } from "./useTabBucketHydration";
import type { TabBucket } from "./projectOps/types";

function bucketTab(id: string): Tab {
  return { ...makeEmptyTab(id, id, "P", "agent"), cwd: `/P/${id}` };
}

function harness(state: Record<string, unknown>) {
  let current = state;
  const setState = (
    update:
      | Record<string, unknown>
      | ((prev: Record<string, unknown>) => Record<string, unknown>),
  ) => {
    current = typeof update === "function" ? update(current) : update;
  };
  return { get: () => current, setState };
}

describe("useTabBucketHydration", () => {
  it("seeds restored buckets into an empty ref", () => {
    const ref = { current: new Map<string, TabBucket>() };
    const h = harness({});
    renderHook(() =>
      useTabBucketHydration(
        {
          "P::workspace::A": { tabs: [bucketTab("a1")], activeTabId: "a1" },
        },
        ref,
        h.get(),
        h.setState,
      ),
    );
    expect(ref.current.get("P::workspace::A")?.activeTabId).toBe("a1");
    expect(ref.current.get("P::workspace::A")?.tabs.map((t) => t.id)).toEqual([
      "a1",
    ]);
  });

  it("never clobbers a bucket the session already populated", () => {
    const live: TabBucket = { tabs: [bucketTab("live")], activeTabId: "live" };
    const ref = {
      current: new Map<string, TabBucket>([["P::workspace::A", live]]),
    };
    const h = harness({});
    renderHook(() =>
      useTabBucketHydration(
        {
          "P::workspace::A": {
            tabs: [bucketTab("stale")],
            activeTabId: "stale",
          },
        },
        ref,
        h.get(),
        h.setState,
      ),
    );
    // Live bucket wins over the disk snapshot.
    expect(ref.current.get("P::workspace::A")?.activeTabId).toBe("live");
  });

  it("promotes the selected workspace bucket when restart restores overview first", () => {
    const tab = bucketTab("a1");
    const ref = { current: new Map<string, TabBucket>() };
    const h = harness({
      activeProjectId: "P",
      activeWorkspaceId: "A",
      activeTabId: "__overview__",
      tabs: [],
      landing: { kind: "workspace", workspaceId: "A" },
      persistedTabBuckets: {
        "P::workspace::A": { tabs: [tab], activeTabId: "a1" },
        "P::workspace::B": { tabs: [bucketTab("b1")], activeTabId: "b1" },
      },
    });

    renderHook(() =>
      useTabBucketHydration(
        h.get().persistedTabBuckets,
        ref,
        h.get(),
        h.setState,
      ),
    );

    expect((h.get().tabs as Tab[]).map((t) => t.id)).toEqual(["a1"]);
    expect(h.get().activeTabId).toBe("a1");
    expect(h.get().landing).toBeNull();
    expect(h.get().messages).toEqual(tab.messages);
    expect(ref.current.has("P::workspace::A")).toBe(false);
    expect(ref.current.get("P::workspace::B")?.activeTabId).toBe("b1");
    expect(
      Object.keys(h.get().persistedTabBuckets as Record<string, TabBucket>),
    ).toEqual(["P::workspace::B"]);
  });

  it("does not replace an already-visible session with a restored bucket", () => {
    const visible = bucketTab("visible");
    const ref = { current: new Map<string, TabBucket>() };
    const h = harness({
      activeProjectId: "P",
      activeWorkspaceId: "A",
      activeTabId: "visible",
      tabs: [visible],
      persistedTabBuckets: {
        "P::workspace::A": { tabs: [bucketTab("stale")], activeTabId: "stale" },
      },
    });

    renderHook(() =>
      useTabBucketHydration(
        h.get().persistedTabBuckets,
        ref,
        h.get(),
        h.setState,
      ),
    );

    expect((h.get().tabs as Tab[]).map((t) => t.id)).toEqual(["visible"]);
    expect(h.get().activeTabId).toBe("visible");
  });

  it("ignores empty / missing snapshots", () => {
    const ref = { current: new Map<string, TabBucket>() };
    const h = harness({});
    renderHook(() =>
      useTabBucketHydration(undefined, ref, h.get(), h.setState),
    );
    renderHook(() => useTabBucketHydration({}, ref, h.get(), h.setState));
    renderHook(() =>
      useTabBucketHydration(
        { "P::workspace::A": { tabs: [] } },
        ref,
        h.get(),
        h.setState,
      ),
    );
    expect(ref.current.size).toBe(0);
  });
});
