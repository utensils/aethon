import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { disposeEditorBuffer } from "../../monaco/editor-buffers";
import type { ProjectsState } from "../../projects";
import type { Tab } from "../../types/tab";
import {
  pathForTab,
  projectIdFromBucketKey,
  workspaceIdForCwd,
  workspaceIdFromBucketKey,
} from "./tabBuckets";
import { mergeClosedSessionIds } from "./workspaceOps/tabCleanup";
import type { TabBucket } from "./types";

export interface OrphanTabSweepDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>;
  closeTabNow: (tabId: string) => void;
  syncRecentSessionsToState: () => void;
}

/**
 * A tab is an orphan when it claims a known project, that project's
 * workspace list is actually loaded, and its cwd resolves to no live
 * project or workspace path anywhere — the signature of a tab whose
 * backing workspace was deleted while the app couldn't clean it up
 * (removed in another instance, or before the reconcile-prune cleanup
 * existed). An absent workspace list means "not yet fetched", which is
 * indistinguishable from "deleted", so those tabs are left alone.
 */
export function isOrphanWorkspaceTab(
  projects: ProjectsState,
  tab: Tab,
): boolean {
  if (!tab.projectId) return false;
  if (tab.kind !== "agent" && tab.kind !== "shell") return false;
  if (!projects.projects.some((p) => p.id === tab.projectId)) return false;
  if (!Array.isArray(projects.workspacesByProject[tab.projectId])) {
    return false;
  }
  const cwd = pathForTab(tab);
  if (!cwd) return false;
  return workspaceIdForCwd(projects, cwd, tab.projectId) === undefined;
}

/** Whole-bucket verdict: a workspace-scoped bucket whose workspace id no
 *  longer exists on a known project is dead in its entirety. */
function bucketWorkspaceIsGone(
  projects: ProjectsState,
  bucketKey: string,
): boolean {
  const projectId = projectIdFromBucketKey(bucketKey);
  const workspaceId = workspaceIdFromBucketKey(bucketKey);
  if (!projectId || !workspaceId) return false;
  if (!projects.projects.some((p) => p.id === projectId)) return false;
  const list = projects.workspacesByProject[projectId];
  if (!Array.isArray(list)) return false;
  return !list.some((w) => w.id === workspaceId);
}

/** Returns the cleaned bucket, `null` to drop it, or the input bucket
 *  unchanged (identity) when nothing matched. Swept agent ids land in
 *  `suppressed` (session suppression + worker teardown); swept shell ids
 *  in `sweptShells` (their PTYs keep running in the Rust ShellRegistry
 *  while hidden and need an explicit shell_close); swept editor ids in
 *  `sweptEditors` (their cached Monaco models become unreachable once
 *  the bucket is gone and must be disposed). */
function cleanBucket(
  projects: ProjectsState,
  bucketKey: string,
  bucket: TabBucket,
  suppressed: Set<string>,
  sweptShells: Set<string>,
  sweptEditors: Set<string>,
): TabBucket | null {
  const tabs = bucket.tabs ?? [];
  const sweep = (tab: Tab) => {
    if (tab.kind === "agent") suppressed.add(tab.id);
    if (tab.kind === "shell") sweptShells.add(tab.id);
    if (tab.kind === "editor") sweptEditors.add(tab.id);
  };
  if (bucketWorkspaceIsGone(projects, bucketKey)) {
    for (const tab of tabs) sweep(tab);
    return null;
  }
  const keep = tabs.filter((tab) => !isOrphanWorkspaceTab(projects, tab));
  if (keep.length === tabs.length) return bucket;
  for (const tab of tabs) {
    if (!keep.includes(tab)) sweep(tab);
  }
  if (keep.length === 0) return null;
  return {
    tabs: keep,
    activeTabId: keep.some((tab) => tab.id === bucket.activeTabId)
      ? bucket.activeTabId
      : keep[0]?.id,
  };
}

/**
 * One-shot boot hygiene: retire tabs and buckets that survived a
 * workspace deletion the app never saw (deleted while it wasn't
 * running, or by an older build without removal cleanup). Restored
 * snapshots are taken verbatim at boot, so without this sweep a dead
 * workspace's session can squat in whatever workspace is active.
 *
 * Conservative on purpose: only tabs/buckets that name a known project
 * with a loaded workspace list are judged; anything ambiguous is kept.
 */
export function sweepOrphanWorkspaceTabs(deps: OrphanTabSweepDeps): void {
  const projects = deps.projectsRef.current;
  const suppressed = new Set<string>();
  const sweptShells = new Set<string>();
  const sweptEditors = new Set<string>();

  // Visible strip: closeTabNow handles closedSessionIds, bridge
  // tab_close / shell_close, and active-tab mirror fixup.
  const visible = (deps.stateRef.current.tabs as Tab[] | undefined) ?? [];
  const visibleOrphans = visible.filter((tab) =>
    isOrphanWorkspaceTab(projects, tab),
  );
  for (const tab of visibleOrphans) deps.closeTabNow(tab.id);

  // Live bucket store.
  for (const [key, bucket] of [...deps.tabBucketsRef.current.entries()]) {
    const next = cleanBucket(
      projects,
      key,
      bucket,
      suppressed,
      sweptShells,
      sweptEditors,
    );
    if (next === bucket) continue;
    if (next === null) deps.tabBucketsRef.current.delete(key);
    else deps.tabBucketsRef.current.set(key, next);
  }

  // Persisted bucket mirror + session suppression.
  const persistedRaw = deps.stateRef.current.persistedTabBuckets;
  const persisted =
    persistedRaw &&
    typeof persistedRaw === "object" &&
    !Array.isArray(persistedRaw)
      ? (persistedRaw as Record<string, TabBucket>)
      : null;
  let nextPersisted: Record<string, TabBucket> | null = null;
  if (persisted) {
    let changed = false;
    const result: Record<string, TabBucket> = {};
    for (const [key, bucket] of Object.entries(persisted)) {
      const next = cleanBucket(
        projects,
        key,
        bucket,
        suppressed,
        sweptShells,
        sweptEditors,
      );
      if (next === bucket) {
        result[key] = bucket;
        continue;
      }
      changed = true;
      if (next === null) continue;
      result[key] = next;
    }
    if (changed) nextPersisted = result;
  }

  if (nextPersisted !== null || suppressed.size > 0) {
    deps.setState((prev) => {
      const result: Record<string, unknown> = { ...prev };
      if (nextPersisted !== null) result.persistedTabBuckets = nextPersisted;
      if (suppressed.size > 0) {
        result.closedSessionIds = mergeClosedSessionIds(
          prev.closedSessionIds,
          suppressed,
        );
      }
      return result;
    });
  }

  // Retire any background workers and hidden-shell PTYs still running
  // for swept hidden tabs. Both sides no-op on unknown tab ids.
  for (const tabId of suppressed) {
    invoke("agent_command", {
      payload: JSON.stringify({ type: "tab_close", tabId }),
    }).catch(() => {
      /* best-effort teardown */
    });
  }
  for (const tabId of sweptShells) {
    invoke("shell_close", { tabId }).catch(() => {
      /* idempotent — already torn down by natural exit */
    });
  }
  // Swept editor tabs: release their cached Monaco models — nothing can
  // reach them once the bucket is gone. No-op for ids without a buffer.
  for (const tabId of sweptEditors) {
    disposeEditorBuffer(tabId);
  }

  if (
    visibleOrphans.length > 0 ||
    suppressed.size > 0 ||
    sweptShells.size > 0 ||
    sweptEditors.size > 0
  ) {
    deps.syncRecentSessionsToState();
  }
}
