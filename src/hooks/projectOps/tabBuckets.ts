import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { NO_PROJECT_KEY, type Tab } from "../../types/tab";
import { recomputeModelPicker } from "../../utils/modelPicker";
import type { ProjectsState } from "../../projects";
import { TAB_MIRROR_KEYS } from "../useTabs";
import type { TabBucket } from "./types";

const WORKTREE_BUCKET_SEPARATOR = "::worktree::";

export function normalizeSessionPath(path: string | undefined): string {
  return (path ?? "").replace(/[/\\]+$/, "");
}

export function projectIdFromBucketKey(key: string): string | null {
  if (key === NO_PROJECT_KEY) return null;
  return key.split(WORKTREE_BUCKET_SEPARATOR, 1)[0] || null;
}

/** Worktree id encoded in a bucket key, or null for a project-main /
 *  no-project bucket. Inverse of `projectScopeBucketKey`. */
export function worktreeIdFromBucketKey(key: string): string | null {
  if (key === NO_PROJECT_KEY) return null;
  const idx = key.indexOf(WORKTREE_BUCKET_SEPARATOR);
  if (idx < 0) return null;
  return key.slice(idx + WORKTREE_BUCKET_SEPARATOR.length) || null;
}

export function projectScopeBucketKey(
  projectId: string | null | undefined,
  worktreeId: string | null | undefined,
): string {
  if (!projectId) return NO_PROJECT_KEY;
  return worktreeId
    ? `${projectId}${WORKTREE_BUCKET_SEPARATOR}${worktreeId}`
    : projectId;
}

export function tabsForProjectBucket(tabs: Tab[], bucketKey: string): Tab[] {
  const projectId = projectIdFromBucketKey(bucketKey);
  return tabs.filter((tab) =>
    projectId === null ? tab.projectId == null : tab.projectId === projectId,
  );
}

export function nonEmptyProjectTabs(tabs: Tab[]): Tab[] {
  return tabs.filter((tab) => {
    if (tab.kind === "shell") return true;
    // Editor tabs always count — even an empty file viewer is worth
    // keeping during a project bucket swap so the user comes back to
    // the same open files. A dirty buffer is doubly worth preserving.
    if (tab.kind === "editor") return true;
    return (
      tab.messages.length > 0 ||
      tab.draft.trim().length > 0 ||
      tab.waiting ||
      tab.queueCount > 0 ||
      tab.canvas !== null ||
      tab.terminalBuffer.length > 0
    );
  });
}

export function worktreeIdForCwd(
  projects: ProjectsState,
  cwd: string | undefined,
  projectId?: string | null,
): string | null | undefined {
  const target = normalizeSessionPath(cwd);
  if (!target) return undefined;
  const orderedProjectIds = [
    ...(projectId ? [projectId] : []),
    ...(projects.activeId && projects.activeId !== projectId
      ? [projects.activeId]
      : []),
    ...projects.projects
      .map((p) => p.id)
      .filter((id) => id !== projectId && id !== projects.activeId),
  ];
  for (const id of orderedProjectIds) {
    const project = projects.projects.find((p) => p.id === id);
    if (!project) continue;
    if (normalizeSessionPath(project.path) === target) return null;
    const worktree = (projects.worktreesByProject[id] ?? []).find(
      (w) => normalizeSessionPath(w.path) === target,
    );
    if (worktree) return worktree.isMain ? null : worktree.id;
  }
  return undefined;
}

export interface SwitchProjectBucketOptions {
  mirrorProjects?: boolean;
}

interface SwitchProjectBucketDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>;
  buildProjectsMirror: (
    prev: Record<string, unknown>,
    tabsForRecent?: Tab[],
  ) => Record<string, unknown>;
  dispatchTerminalReplay: (buffer: string) => void;
}

/**
 * Snapshot current state.tabs + activeTabId into the old project bucket,
 * then load the new project bucket back into root state. This is the
 * load-bearing transition that makes tabs project-scoped without
 * filtering on every render.
 */
export function switchProjectBucket(
  deps: SwitchProjectBucketDeps,
  fromKey: string,
  toKey: string,
  opts: SwitchProjectBucketOptions = {},
): string | undefined {
  const {
    setState,
    stateRef,
    tabBucketsRef,
    buildProjectsMirror,
    dispatchTerminalReplay,
  } = deps;
  if (fromKey === toKey) {
    if (opts.mirrorProjects === true) {
      setState((prev) => ({ ...prev, ...buildProjectsMirror(prev) }));
    }
    return stateRef.current.activeTabId as string | undefined;
  }
  let nextTerminalBuffer = "";
  let nextActiveTabId: string | undefined;
  setState((prev) => {
    const currentTabs = nonEmptyProjectTabs(
      tabsForProjectBucket(
        ((prev.tabs as Tab[] | undefined) ?? []).slice(),
        fromKey,
      ),
    );
    const currentActive = prev.activeTabId as string | undefined;
    const fromActiveTabId = currentTabs.some((t) => t.id === currentActive)
      ? currentActive
      : currentTabs[0]?.id;
    tabBucketsRef.current.set(fromKey, {
      tabs: currentTabs,
      activeTabId: fromActiveTabId,
    });

    const savedNextRaw = tabBucketsRef.current.get(toKey);
    const savedNext = savedNextRaw
      ? {
          tabs: nonEmptyProjectTabs(
            tabsForProjectBucket(savedNextRaw.tabs, toKey),
          ),
          activeTabId: savedNextRaw.activeTabId,
        }
      : undefined;
    const next =
      savedNext && savedNext.tabs.length > 0
        ? savedNext
        : { tabs: [], activeTabId: undefined };

    const hasOrphan =
      next.tabs.length > 0 && !next.tabs.some((t) => t.id === next.activeTabId);
    const activeTabId = hasOrphan ? next.tabs[0].id : next.activeTabId;
    nextActiveTabId = activeTabId;

    // Mirror the non-active workspace buckets into state so a restart can
    // restore each workspace's tabs (not just the active one's). The active
    // workspace's tabs live in `state.tabs`, so exclude `toKey` (now active);
    // `fromKey` was just snapshotted into tabBucketsRef above.
    const persistedTabBuckets: Record<string, TabBucket> = {};
    for (const [bucketKey, bucket] of tabBucketsRef.current.entries()) {
      if (bucketKey === toKey) continue;
      persistedTabBuckets[bucketKey] = {
        tabs: bucket.tabs,
        activeTabId: bucket.activeTabId,
      };
    }

    const result: Record<string, unknown> = {
      ...prev,
      tabs: next.tabs,
      activeTabId,
      persistedTabBuckets,
    };
    const activeTab = next.tabs.find((t) => t.id === activeTabId);
    if (activeTab) {
      const rec = activeTab as unknown as Record<string, unknown>;
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = rec[key as string];
      }
      result.empty = false;
      result.hasTabs = true;
      // Restoring a real tab must clear any worktree-landing override,
      // matching setActiveTab's invariant so the active tab's canvas owns
      // the main surface after a workspace switch.
      result.landing = null;
      result.sidebar = recomputeModelPicker(
        prev.sidebar as Record<string, unknown> | undefined,
        activeTab.model,
      );
      nextTerminalBuffer = activeTab.terminalBuffer ?? "";
    } else {
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = undefined;
      }
      result.empty = true;
      result.hasTabs = next.tabs.length > 0;
      nextTerminalBuffer = "";
    }
    if (opts.mirrorProjects === true) {
      Object.assign(result, buildProjectsMirror(result, next.tabs));
    }
    return result;
  });
  dispatchTerminalReplay(nextTerminalBuffer);
  return nextActiveTabId;
}
