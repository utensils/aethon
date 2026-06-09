// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeEmptyTab, type Tab } from "../types/tab";
import { useTabBucketHydration } from "./useTabBucketHydration";
import type { TabBucket } from "./projectOps/types";

function bucketTab(id: string): Tab {
  return { ...makeEmptyTab(id, id, "P", "agent"), cwd: `/P/${id}` };
}

describe("useTabBucketHydration", () => {
  it("seeds restored buckets into an empty ref", () => {
    const ref = { current: new Map<string, TabBucket>() };
    renderHook(() =>
      useTabBucketHydration(
        {
          "P::workspace::A": { tabs: [bucketTab("a1")], activeTabId: "a1" },
        },
        ref,
      ),
    );
    expect(ref.current.get("P::workspace::A")?.activeTabId).toBe("a1");
    expect(ref.current.get("P::workspace::A")?.tabs.map((t) => t.id)).toEqual([
      "a1",
    ]);
  });

  it("never clobbers a bucket the session already populated", () => {
    const live: TabBucket = { tabs: [bucketTab("live")], activeTabId: "live" };
    const ref = { current: new Map<string, TabBucket>([["P::workspace::A", live]]) };
    renderHook(() =>
      useTabBucketHydration(
        {
          "P::workspace::A": { tabs: [bucketTab("stale")], activeTabId: "stale" },
        },
        ref,
      ),
    );
    // Live bucket wins over the disk snapshot.
    expect(ref.current.get("P::workspace::A")?.activeTabId).toBe("live");
  });

  it("ignores empty / missing snapshots", () => {
    const ref = { current: new Map<string, TabBucket>() };
    renderHook(() => useTabBucketHydration(undefined, ref));
    renderHook(() => useTabBucketHydration({}, ref));
    renderHook(() =>
      useTabBucketHydration({ "P::workspace::A": { tabs: [] } }, ref),
    );
    expect(ref.current.size).toBe(0);
  });
});
