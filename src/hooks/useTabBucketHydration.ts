import { useEffect, type MutableRefObject } from "react";
import type { Tab } from "../types/tab";
import type { TabBucket } from "./projectOps/types";

/**
 * Hydrate per-workspace tab buckets restored from disk
 * (`state.persistedTabBuckets`) into the live `tabBucketsRef`.
 *
 * Only the ACTIVE workspace's tabs live in `state.tabs`; every other open
 * workspace is stashed in `tabBucketsRef`, which is not itself persisted. On
 * boot the persistence layer puts the restored non-active buckets into
 * `state.persistedTabBuckets`; this effect copies them into the live ref so
 * switching to a backgrounded workspace after a restart lands on the tab the
 * user last had open there instead of the empty landing card.
 *
 * Never clobbers a bucket the session has already populated (so a live switch
 * always wins over a stale disk snapshot), and is safe to re-run when an async
 * disk restore lands after first paint.
 */
export function useTabBucketHydration(
  persistedTabBuckets: unknown,
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>,
): void {
  useEffect(() => {
    if (
      !persistedTabBuckets ||
      typeof persistedTabBuckets !== "object" ||
      Array.isArray(persistedTabBuckets)
    ) {
      return;
    }
    const restored = persistedTabBuckets as Record<
      string,
      { tabs?: Tab[]; activeTabId?: string }
    >;
    for (const [key, bucket] of Object.entries(restored)) {
      if (tabBucketsRef.current.has(key)) continue;
      if (!Array.isArray(bucket?.tabs) || bucket.tabs.length === 0) continue;
      tabBucketsRef.current.set(key, {
        tabs: bucket.tabs,
        activeTabId: bucket.activeTabId,
      });
    }
  }, [persistedTabBuckets, tabBucketsRef]);
}
