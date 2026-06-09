import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { projectScopeBucketKey } from "../projectOps/tabBuckets";
import type { TabBucket } from "../projectOps/types";
import type { ProjectsState } from "../../projects";
import type { Tab } from "../../types/tab";

export interface CloseAllWorkspaceSessionsDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>;
  closeTab: (tabId: string) => void;
}

function onlyShellTabs(tabs: readonly Tab[]): Tab[] {
  return tabs.filter((tab) => tab.kind === "shell");
}

function addAgentIds(ids: Set<string>, tabs: readonly Tab[]): void {
  for (const tab of tabs) {
    if (tab.kind === "agent") ids.add(tab.id);
  }
}

function shellOnlyBucket(bucket: TabBucket): TabBucket | null {
  const tabs = onlyShellTabs(bucket.tabs);
  if (tabs.length === 0) return null;
  return {
    tabs,
    activeTabId: tabs.some((tab) => tab.id === bucket.activeTabId)
      ? bucket.activeTabId
      : undefined,
  };
}

/**
 * Close every non-shell tab in the active workspace and make the close
 * authoritative across both visible state and the restored bucket mirror.
 *
 * Host overview uses the no-project bucket, so stale host bucket entries can
 * otherwise rehydrate sessions after the visible tabs have been closed.
 */
export function closeAllWorkspaceSessions(
  deps: CloseAllWorkspaceSessionsDeps,
): void {
  const { setState, stateRef, projectsRef, tabBucketsRef, closeTab } = deps;
  const bucketKey = projectScopeBucketKey(
    projectsRef.current.activeId,
    projectsRef.current.activeWorkspaceId,
  );
  const visibleTabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
  const visibleSessionTabs = visibleTabs.filter((tab) => tab.kind !== "shell");
  const agentIdsToSuppress = new Set<string>();
  addAgentIds(agentIdsToSuppress, visibleSessionTabs);

  const inMemoryBucket = tabBucketsRef.current.get(bucketKey);
  if (inMemoryBucket) {
    addAgentIds(agentIdsToSuppress, inMemoryBucket.tabs);
    const shellBucket = shellOnlyBucket(inMemoryBucket);
    if (shellBucket) {
      tabBucketsRef.current.set(bucketKey, shellBucket);
    } else {
      tabBucketsRef.current.delete(bucketKey);
    }
  }

  for (const tab of visibleSessionTabs) {
    closeTab(tab.id);
  }

  setState((prev) => {
    const result: Record<string, unknown> = { ...prev };
    const persisted =
      prev.persistedTabBuckets &&
      typeof prev.persistedTabBuckets === "object" &&
      !Array.isArray(prev.persistedTabBuckets)
        ? (prev.persistedTabBuckets as Record<string, TabBucket>)
        : {};
    const persistedBucket = persisted[bucketKey];
    if (persistedBucket) {
      addAgentIds(agentIdsToSuppress, persistedBucket.tabs);
      const nextPersisted = { ...persisted };
      const shellBucket = shellOnlyBucket(persistedBucket);
      if (shellBucket) {
        nextPersisted[bucketKey] = shellBucket;
      } else {
        delete nextPersisted[bucketKey];
      }
      result.persistedTabBuckets = nextPersisted;
    }

    if (agentIdsToSuppress.size > 0) {
      const closedIds = Array.isArray(prev.closedSessionIds)
        ? (prev.closedSessionIds as string[])
        : [];
      result.closedSessionIds = Array.from(
        new Set([...closedIds, ...agentIdsToSuppress]),
      ).slice(-200);
    }

    return result;
  });
}
