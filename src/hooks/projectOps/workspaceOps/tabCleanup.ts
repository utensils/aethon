import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { disposeEditorBuffer } from "../../../monaco/editor-buffers";
import type { Tab } from "../../../types/tab";
import { normalizeSessionPath, projectScopeBucketKey } from "../tabBuckets";
import type { TabBucket } from "../types";

export interface TabCleanupDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>;
  syncRecentSessionsToState: () => void;
  closeTabNow: (tabId: string) => void;
  activateWorkspace: (workspaceId: string | null) => void;
}

const CLOSED_SESSION_IDS_CAP = 200;

function tabCwdMatches(tab: Tab, path: string): boolean {
  const target = normalizeSessionPath(path);
  if (!target) return false;
  if (tab.kind === "agent") return normalizeSessionPath(tab.cwd) === target;
  // Shell tabs anchor their PTY at shell.cwd; a removed worktree leaves
  // them pointing at a deleted directory, so they go too.
  if (tab.kind === "shell") {
    return normalizeSessionPath(tab.shell?.cwd ?? tab.cwd) === target;
  }
  return false;
}

function readPersistedBuckets(
  value: unknown,
): Record<string, TabBucket> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, TabBucket>;
}

/** Agent-, shell-, and editor-tab ids retired with the removed
 *  workspace, gathered from every store: its own bucket (matching cwd
 *  or not — the bucket IS the workspace's tab set), plus matching-cwd
 *  agent/shell tabs in any other bucket and the persisted mirror.
 *  Agent ids feed closedSessionIds suppression + worker teardown;
 *  shell ids feed PTY teardown (their processes keep running in the
 *  Rust ShellRegistry while hidden); editor ids feed Monaco buffer
 *  disposal (the buffer cache is intentionally long-lived for hidden
 *  buckets, but a dropped bucket leaves no UI handle to ever reach the
 *  model again). Editor tabs only retire with their own bucket — they
 *  have no cwd to match elsewhere. Must run BEFORE any mutation: the
 *  wasActive bucket switch rewrites the removed workspace's bucket and
 *  would lose these ids. */
function collectRemovedTabIds(
  deps: Pick<TabCleanupDeps, "stateRef" | "tabBucketsRef">,
  path: string,
  removedBucketKey: string,
): { agentIds: Set<string>; shellIds: Set<string>; editorIds: Set<string> } {
  const agentIds = new Set<string>();
  const shellIds = new Set<string>();
  const editorIds = new Set<string>();
  const collect = (key: string, tabs: readonly Tab[] | undefined) => {
    for (const tab of tabs ?? []) {
      if (tab.kind === "editor") {
        if (key === removedBucketKey) editorIds.add(tab.id);
        continue;
      }
      if (tab.kind !== "agent" && tab.kind !== "shell") continue;
      if (key === removedBucketKey || tabCwdMatches(tab, path)) {
        (tab.kind === "agent" ? agentIds : shellIds).add(tab.id);
      }
    }
  };
  for (const [key, bucket] of deps.tabBucketsRef.current.entries()) {
    collect(key, bucket.tabs);
  }
  const persisted = readPersistedBuckets(
    deps.stateRef.current.persistedTabBuckets,
  );
  if (persisted) {
    for (const [key, bucket] of Object.entries(persisted)) {
      collect(key, bucket.tabs);
    }
  }
  return { agentIds, shellIds, editorIds };
}

function filterBucket(bucket: TabBucket, path: string): TabBucket | null {
  const keep = bucket.tabs.filter((tab) => !tabCwdMatches(tab, path));
  if (keep.length === bucket.tabs.length) return bucket;
  if (keep.length === 0) return null;
  return {
    tabs: keep,
    activeTabId: keep.some((tab) => tab.id === bucket.activeTabId)
      ? bucket.activeTabId
      : keep[0]?.id,
  };
}

function removeStoredTabsForWorkspacePath(
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>,
  path: string,
  removedBucketKey: string,
): void {
  tabBucketsRef.current.delete(removedBucketKey);
  for (const [key, bucket] of tabBucketsRef.current.entries()) {
    const next = filterBucket(bucket, path);
    if (next === bucket) continue;
    if (next === null) {
      tabBucketsRef.current.delete(key);
      continue;
    }
    tabBucketsRef.current.set(key, next);
  }
}

function closeVisibleTabsForWorkspacePath(
  stateRef: MutableRefObject<Record<string, unknown>>,
  closeTabNow: (tabId: string) => void,
  path: string,
): Set<string> {
  const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
  const closing = tabs.filter((tab) => tabCwdMatches(tab, path));
  for (const tab of closing) closeTabNow(tab.id);
  // closeTabNow owns the full teardown for these (bridge tab_close for
  // agents, shell_close for shells) — the caller skips them.
  return new Set(closing.map((tab) => tab.id));
}

export function mergeClosedSessionIds(
  prev: unknown,
  ids: Iterable<string>,
): string[] {
  const closedIds = Array.isArray(prev) ? (prev as string[]) : [];
  return Array.from(new Set([...closedIds, ...ids])).slice(
    -CLOSED_SESSION_IDS_CAP,
  );
}

export function closeTabsForRemovedWorkspace(
  deps: TabCleanupDeps,
  projectId: string,
  workspaceId: string,
  path: string,
  wasActive: boolean,
): void {
  const removedBucketKey = projectScopeBucketKey(projectId, workspaceId);
  const {
    agentIds: suppressed,
    shellIds,
    editorIds,
  } = collectRemovedTabIds(deps, path, removedBucketKey);
  const visibleClosed = closeVisibleTabsForWorkspacePath(
    deps.stateRef,
    deps.closeTabNow,
    path,
  );
  if (wasActive) deps.activateWorkspace(null);
  removeStoredTabsForWorkspacePath(deps.tabBucketsRef, path, removedBucketKey);

  // Purge the persisted-bucket mirror too — otherwise a webview reload
  // rehydrates the removed workspace's tabs straight back into the ref.
  // Read it AFTER the activate/close mutations so we purge the freshest
  // mirror, but suppress with the ids collected up front.
  const persisted = readPersistedBuckets(
    deps.stateRef.current.persistedTabBuckets,
  );
  let nextPersisted: Record<string, TabBucket> | null = null;
  if (persisted) {
    let changed = false;
    const result: Record<string, TabBucket> = {};
    for (const [key, bucket] of Object.entries(persisted)) {
      if (key === removedBucketKey) {
        changed = true;
        continue;
      }
      const original: TabBucket = {
        tabs: bucket.tabs ?? [],
        activeTabId: bucket.activeTabId,
      };
      const next = filterBucket(original, path);
      if (next === original) {
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
        // Suppress the retired sessions from discovery-driven auto-restore.
        // A deleted workspace's session must not resurrect into whatever
        // workspace happens to be active later.
        result.closedSessionIds = mergeClosedSessionIds(
          prev.closedSessionIds,
          suppressed,
        );
      }
      return result;
    });
  }

  // Retire background workers and hidden-shell PTYs for tabs that were
  // never visible — closeTabNow already tore down the visible ones. The
  // bridge and the shell registry both no-op on unknown tab ids.
  for (const tabId of suppressed) {
    if (visibleClosed.has(tabId)) continue;
    invoke("agent_command", {
      payload: JSON.stringify({ type: "tab_close", tabId }),
    }).catch(() => {
      /* best-effort teardown */
    });
  }
  for (const tabId of shellIds) {
    if (visibleClosed.has(tabId)) continue;
    invoke("shell_close", { tabId }).catch(() => {
      /* idempotent — already torn down by natural exit */
    });
  }
  // Hidden editor tabs dropped with the bucket: release their cached
  // Monaco models — nothing can reach them again. No-op for ids that
  // never materialised a buffer.
  for (const tabId of editorIds) {
    if (visibleClosed.has(tabId)) continue;
    disposeEditorBuffer(tabId);
  }

  deps.syncRecentSessionsToState();
}
