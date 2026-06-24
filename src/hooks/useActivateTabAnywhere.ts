import { useCallback, type MutableRefObject } from "react";
import type { Tab } from "../types/tab";
import type { TabBucket } from "./projectOps/types";
import {
  projectIdFromBucketKey,
  workspaceIdFromBucketKey,
} from "./useProjectOps";

export interface ActivateTabAnywhereDeps {
  stateRef: MutableRefObject<Record<string, unknown>>;
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>;
  setActiveTab: (tabId: string) => void;
  setActiveProjectById: (projectId: string) => boolean;
  clearActiveProject: () => void;
  activateWorkspace: (workspaceId: string | null) => void;
}

export function activateTabAnywhereNow(
  deps: ActivateTabAnywhereDeps,
  tabId: string,
): void {
  const {
    stateRef,
    tabBucketsRef,
    setActiveTab,
    setActiveProjectById,
    clearActiveProject,
    activateWorkspace,
  } = deps;
  const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
  if (tabs.some((tab) => tab.id === tabId)) {
    setActiveTab(tabId);
    return;
  }

  // Not in the active workspace — find the bucket that owns it, switch into
  // that project/workspace, then select. setState is synchronous, so the
  // bucket load lands before setActiveTab reads state.tabs.
  for (const [key, bucket] of tabBucketsRef.current.entries()) {
    if (!bucket.tabs.some((tab) => tab.id === tabId)) continue;
    const projectId = projectIdFromBucketKey(key);
    const currentProjectId =
      (stateRef.current.activeProjectId as string | null | undefined) ?? null;
    if (projectId !== currentProjectId) {
      if (projectId) setActiveProjectById(projectId);
      else clearActiveProject();
    }
    activateWorkspace(workspaceIdFromBucketKey(key));
    setActiveTab(tabId);
    return;
  }

  // Unknown tab — best effort (no-op if it's truly gone).
  setActiveTab(tabId);
}

export function useActivateTabAnywhere({
  stateRef,
  tabBucketsRef,
  setActiveTab,
  setActiveProjectById,
  clearActiveProject,
  activateWorkspace,
}: ActivateTabAnywhereDeps): (tabId: string) => void {
  return useCallback(
    (tabId: string) => {
      activateTabAnywhereNow(
        {
          stateRef,
          tabBucketsRef,
          setActiveTab,
          setActiveProjectById,
          clearActiveProject,
          activateWorkspace,
        },
        tabId,
      );
    },
    [
      activateWorkspace,
      clearActiveProject,
      setActiveProjectById,
      setActiveTab,
      stateRef,
      tabBucketsRef,
    ],
  );
}
