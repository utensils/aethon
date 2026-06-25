import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ProjectsState } from "../projects";
import type { Tab } from "../types/tab";
import {
  clearClosedIssueLinks,
  clearClosedIssueLinksInBuckets,
} from "../extensions/default-layout/dashboard/issue-sessions";
import type { TabBucket } from "./projectOps/types";
import { findTabAcrossBuckets, updateTabAcrossBuckets } from "./tabRouting";

interface UseRoutedTabHelpersArgs {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>;
}

export interface RoutedTabHelpers {
  updateTabRouted: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  findTabRouted: (tabId: string) => Tab | undefined;
  clearClosedIssueLinksForProject: (
    projectId: string,
    openIssueNumbers: ReadonlySet<number>,
  ) => void;
}

export function useRoutedTabHelpers({
  setState,
  stateRef,
  projectsRef,
  tabBucketsRef,
}: UseRoutedTabHelpersArgs): RoutedTabHelpers {
  const updateTabRouted = useCallback(
    (tabId: string, mutator: (tab: Tab) => Tab) => {
      updateTabAcrossBuckets(
        { setState, stateRef, projectsRef, tabBucketsRef },
        tabId,
        mutator,
      );
    },
    [projectsRef, setState, stateRef, tabBucketsRef],
  );

  const findTabRouted = useCallback(
    (tabId: string) => findTabAcrossBuckets(stateRef, tabBucketsRef, tabId),
    [stateRef, tabBucketsRef],
  );

  const clearClosedIssueLinksForProject = useCallback(
    (projectId: string, openIssueNumbers: ReadonlySet<number>) => {
      clearClosedIssueLinksInBuckets(
        tabBucketsRef.current,
        projectId,
        openIssueNumbers,
      );
      setState((prev) =>
        clearClosedIssueLinks(prev, projectId, openIssueNumbers),
      );
    },
    [setState, tabBucketsRef],
  );

  return { updateTabRouted, findTabRouted, clearClosedIssueLinksForProject };
}
