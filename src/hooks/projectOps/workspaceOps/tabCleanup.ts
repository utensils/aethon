import type { MutableRefObject } from "react";
import type { Tab } from "../../../types/tab";
import { normalizeSessionPath, projectScopeBucketKey } from "../tabBuckets";
import type { TabBucket } from "../types";

interface TabCleanupDeps {
  stateRef: MutableRefObject<Record<string, unknown>>;
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>;
  syncRecentSessionsToState: () => void;
  closeTabNow: (tabId: string) => void;
  activateWorkspace: (workspaceId: string | null) => void;
}

function tabCwdMatches(tab: Tab, path: string): boolean {
  if (tab.kind !== "agent") return false;
  return normalizeSessionPath(tab.cwd) === normalizeSessionPath(path);
}

function removeStoredTabsForWorkspacePath(
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>,
  path: string,
  removedBucketKey: string,
): void {
  tabBucketsRef.current.delete(removedBucketKey);
  for (const [key, bucket] of tabBucketsRef.current.entries()) {
    const tabs = bucket.tabs.filter((tab) => !tabCwdMatches(tab, path));
    if (tabs.length === bucket.tabs.length) continue;
    if (tabs.length === 0) {
      tabBucketsRef.current.delete(key);
      continue;
    }
    const activeTabId = tabs.some((tab) => tab.id === bucket.activeTabId)
      ? bucket.activeTabId
      : tabs[0]?.id;
    tabBucketsRef.current.set(key, { tabs, activeTabId });
  }
}

function closeVisibleTabsForWorkspacePath(
  stateRef: MutableRefObject<Record<string, unknown>>,
  closeTabNow: (tabId: string) => void,
  path: string,
): void {
  const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
  const closing = tabs
    .filter((tab) => tabCwdMatches(tab, path))
    .map((tab) => tab.id);
  for (const tabId of closing) closeTabNow(tabId);
}

export function closeTabsForRemovedWorkspace(
  deps: TabCleanupDeps,
  projectId: string,
  workspaceId: string,
  path: string,
  wasActive: boolean,
): void {
  closeVisibleTabsForWorkspacePath(deps.stateRef, deps.closeTabNow, path);
  if (wasActive) deps.activateWorkspace(null);
  removeStoredTabsForWorkspacePath(
    deps.tabBucketsRef,
    path,
    projectScopeBucketKey(projectId, workspaceId),
  );
  deps.syncRecentSessionsToState();
}
