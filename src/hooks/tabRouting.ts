import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ProjectsState } from "../projects";
import type { Tab } from "../types/tab";
import { TAB_MIRROR_KEYS } from "./tabOps/constants";
import { projectScopeBucketKey } from "./projectOps/tabBuckets";
import type { TabBucket } from "./projectOps/types";

export interface TabRoutingDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>;
}

function activeBucketKey(projects: ProjectsState): string {
  return projectScopeBucketKey(projects.activeId, projects.activeWorkspaceId);
}

function persistedBuckets(
  buckets: Map<string, TabBucket>,
  activeKey: string,
): Record<string, TabBucket> {
  const result: Record<string, TabBucket> = {};
  for (const [key, bucket] of buckets.entries()) {
    if (key === activeKey) continue;
    result[key] = {
      tabs: bucket.tabs,
      activeTabId: bucket.activeTabId,
    };
  }
  return result;
}

export function findTabAcrossBuckets(
  stateRef: MutableRefObject<Record<string, unknown>>,
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>,
  tabId: string,
): Tab | undefined {
  const visible = ((stateRef.current.tabs as Tab[] | undefined) ?? []).find(
    (tab) => tab.id === tabId,
  );
  if (visible) return visible;
  for (const bucket of tabBucketsRef.current.values()) {
    const hidden = bucket.tabs.find((tab) => tab.id === tabId);
    if (hidden) return hidden;
  }
  return undefined;
}

export function updateTabAcrossBuckets(
  deps: TabRoutingDeps,
  tabId: string,
  mutator: (tab: Tab) => Tab,
): void {
  const { setState, projectsRef, tabBucketsRef } = deps;
  setState((prev) => {
    const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
    const visibleIndex = tabs.findIndex((tab) => tab.id === tabId);
    if (visibleIndex >= 0) {
      const next = mutator(tabs[visibleIndex]);
      tabs[visibleIndex] = next;
      const result: Record<string, unknown> = { ...prev, tabs };
      if (prev.activeTabId === tabId) {
        const rec = next as unknown as Record<string, unknown>;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = rec[key as string];
        }
      }
      return result;
    }

    const activeKey = activeBucketKey(projectsRef.current);
    for (const [key, bucket] of tabBucketsRef.current.entries()) {
      const hiddenIndex = bucket.tabs.findIndex((tab) => tab.id === tabId);
      if (hiddenIndex < 0) continue;
      const hiddenTabs = bucket.tabs.slice();
      hiddenTabs[hiddenIndex] = mutator(hiddenTabs[hiddenIndex]);
      tabBucketsRef.current.set(key, {
        tabs: hiddenTabs,
        activeTabId: bucket.activeTabId ?? hiddenTabs[0]?.id,
      });
      return {
        ...prev,
        persistedTabBuckets: persistedBuckets(
          tabBucketsRef.current,
          activeKey,
        ),
      };
    }

    return prev;
  });
}
