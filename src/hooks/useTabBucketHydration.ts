import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Tab } from "../types/tab";
import { TAB_MIRROR_KEYS } from "./useTabs";
import { projectScopeBucketKey } from "./projectOps/tabBuckets";
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
  state: Record<string, unknown>,
  setState: Dispatch<SetStateAction<Record<string, unknown>>>,
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

    const activeProjectId =
      typeof state.activeProjectId === "string" ? state.activeProjectId : null;
    if (!activeProjectId) return;
    const activeWorkspaceId =
      typeof state.activeWorkspaceId === "string"
        ? state.activeWorkspaceId
        : null;
    const activeBucketKey = projectScopeBucketKey(
      activeProjectId,
      activeWorkspaceId,
    );
    const activeBucket = restored[activeBucketKey];
    if (!activeBucket?.tabs?.length) return;

    setState((prev) => {
      const visibleTabs = Array.isArray(prev.tabs) ? (prev.tabs as Tab[]) : [];
      const visibleOwnsSession = visibleTabs.some(
        (tab) => tab.kind === "agent" || tab.kind === "editor",
      );
      if (visibleOwnsSession) return prev;

      const tabs = activeBucket.tabs ?? [];
      if (tabs.length === 0) return prev;
      const preferred =
        typeof activeBucket.activeTabId === "string" &&
        tabs.some((tab) => tab.id === activeBucket.activeTabId)
          ? activeBucket.activeTabId
          : (tabs.find((tab) => tab.kind === "agent" || tab.kind === "editor")
              ?.id ?? tabs[0]?.id);
      const activeTab = tabs.find((tab) => tab.id === preferred);
      if (!activeTab || activeTab.kind === "shell") return prev;

      const nextPersisted =
        prev.persistedTabBuckets &&
        typeof prev.persistedTabBuckets === "object" &&
        !Array.isArray(prev.persistedTabBuckets)
          ? {
              ...(prev.persistedTabBuckets as Record<string, TabBucket>),
            }
          : {};
      delete nextPersisted[activeBucketKey];
      tabBucketsRef.current.delete(activeBucketKey);

      const result: Record<string, unknown> = {
        ...prev,
        tabs,
        activeTabId: activeTab.id,
        persistedTabBuckets: nextPersisted,
        empty: false,
        hasTabs: true,
        landing: null,
      };
      const activeRecord = activeTab as unknown as Record<string, unknown>;
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = activeRecord[key as string];
      }
      return result;
    });
  }, [
    persistedTabBuckets,
    setState,
    state.activeProjectId,
    state.activeTabId,
    state.activeWorkspaceId,
    state.tabs,
    tabBucketsRef,
  ]);
}
