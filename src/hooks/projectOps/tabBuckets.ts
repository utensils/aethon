import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { NO_PROJECT_KEY, OVERVIEW_TAB_ID, type Tab } from "../../types/tab";
import { recomputeModelPicker } from "../../utils/modelPicker";
import type { ProjectsState } from "../../projects";
import { TAB_MIRROR_KEYS } from "../useTabs";
import { mirrorOverviewSurfaceToRoot } from "../tabOps/helpers";
import type { TabBucket } from "./types";

const WORKSPACE_BUCKET_SEPARATOR = "::workspace::";

export function normalizeSessionPath(path: string | undefined): string {
  return (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function projectIdFromBucketKey(key: string): string | null {
  if (key === NO_PROJECT_KEY) return null;
  return key.split(WORKSPACE_BUCKET_SEPARATOR, 1)[0] || null;
}

/** Workspace id encoded in a bucket key, or null for a project-main /
 *  no-project bucket. Inverse of `projectScopeBucketKey`. */
export function workspaceIdFromBucketKey(key: string): string | null {
  if (key === NO_PROJECT_KEY) return null;
  const idx = key.indexOf(WORKSPACE_BUCKET_SEPARATOR);
  if (idx < 0) return null;
  return key.slice(idx + WORKSPACE_BUCKET_SEPARATOR.length) || null;
}

export function projectScopeBucketKey(
  projectId: string | null | undefined,
  workspaceId: string | null | undefined,
): string {
  if (!projectId) return NO_PROJECT_KEY;
  return workspaceId
    ? `${projectId}${WORKSPACE_BUCKET_SEPARATOR}${workspaceId}`
    : projectId;
}

function isSameOrChildPath(path: string, root: string): boolean {
  if (!path || !root) return false;
  return path === root || path.startsWith(`${root}/`);
}

export function pathForTab(tab: Tab): string | undefined {
  if (tab.kind === "shell") return tab.shell?.cwd ?? tab.cwd;
  if (tab.kind === "editor")
    return tab.editor?.rootPath ?? tab.editor?.filePath;
  return tab.cwd;
}

export function tabBucketKeyForTab(projects: ProjectsState, tab: Tab): string {
  if (!tab.projectId) return NO_PROJECT_KEY;
  const resolved = workspaceIdForCwd(projects, pathForTab(tab), tab.projectId);
  return projectScopeBucketKey(tab.projectId, resolved ?? null);
}

export function tabsForProjectBucket(
  tabs: Tab[],
  bucketKey: string,
  projects?: ProjectsState,
): Tab[] {
  const projectId = projectIdFromBucketKey(bucketKey);
  return tabs.filter((tab) => {
    if (projectId === null) return tab.projectId == null;
    if (tab.projectId !== projectId) return false;
    if (!projects) return true;
    return tabBucketKeyForTab(projects, tab) === bucketKey;
  });
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

function preferredActiveTabId(
  tabs: Tab[],
  currentActive: string | undefined,
  existingActive: string | undefined,
): string | undefined {
  if (
    currentActive !== OVERVIEW_TAB_ID &&
    tabs.some((t) => t.id === currentActive)
  ) {
    return currentActive;
  }
  if (tabs.some((t) => t.id === existingActive)) return existingActive;
  return (
    tabs.find((t) => t.kind === "agent" || t.kind === "editor")?.id ??
    tabs[0]?.id
  );
}

export function workspaceIdForCwd(
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
    const candidates = [
      { id: null as string | null, path: project.path, isMain: true },
      ...(projects.workspacesByProject[id] ?? []).map((w) => ({
        id: w.id,
        path: w.path,
        isMain: w.isMain,
      })),
    ]
      .map((item) => ({ ...item, path: normalizeSessionPath(item.path) }))
      .filter((item) => isSameOrChildPath(target, item.path))
      .sort((a, b) => b.path.length - a.path.length);
    const hit = candidates[0];
    if (hit) return hit.isMain ? null : hit.id;
  }
  return undefined;
}

export interface SwitchProjectBucketOptions {
  mirrorProjects?: boolean;
}

interface SwitchProjectBucketDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projects: ProjectsState;
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
    projects,
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
    const visibleTabs = nonEmptyProjectTabs(
      ((prev.tabs as Tab[] | undefined) ?? []).slice(),
    );
    const currentActive = prev.activeTabId as string | undefined;
    const visibleBuckets = new Map<string, Tab[]>();
    for (const tab of visibleTabs) {
      const bucketKey = tabBucketKeyForTab(projects, tab);
      visibleBuckets.set(bucketKey, [
        ...(visibleBuckets.get(bucketKey) ?? []),
        tab,
      ]);
    }
    if (!visibleBuckets.has(fromKey)) visibleBuckets.set(fromKey, []);
    for (const [bucketKey, bucketTabs] of visibleBuckets.entries()) {
      const existing = tabBucketsRef.current.get(bucketKey);
      const activeTabId = preferredActiveTabId(
        bucketTabs,
        currentActive,
        existing?.activeTabId,
      );
      tabBucketsRef.current.set(bucketKey, {
        tabs: bucketTabs,
        activeTabId,
      });
    }

    const savedNextRaw = tabBucketsRef.current.get(toKey);
    const savedNext = savedNextRaw
      ? {
          tabs: nonEmptyProjectTabs(
            tabsForProjectBucket(savedNextRaw.tabs, toKey, projects),
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
    const attention = prev.agentAttentionTabs as
      | Record<string, true>
      | undefined;
    if (activeTabId && attention?.[activeTabId]) {
      const nextAttention = { ...attention };
      delete nextAttention[activeTabId];
      result.agentAttentionTabs = nextAttention;
    }
    const activeTab = next.tabs.find((t) => t.id === activeTabId);
    if (activeTab) {
      const rec = activeTab as unknown as Record<string, unknown>;
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = rec[key as string];
      }
      const visibleModel =
        activeTab.kind === "shell"
          ? mirrorOverviewSurfaceToRoot(result, prev)
          : activeTab.model;
      result.empty = false;
      result.hasTabs = true;
      // Restoring a real tab must clear any workspace-landing override,
      // matching setActiveTab's invariant so the active tab's canvas owns
      // the main surface after a workspace switch.
      result.landing = null;
      result.sidebar = recomputeModelPicker(
        prev.sidebar as Record<string, unknown> | undefined,
        visibleModel,
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
