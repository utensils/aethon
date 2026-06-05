// Worktrees — git worktree handles attached to a Project.
//
// Modelled after Codex's discovery-not-creation pattern: the source of
// truth is `.git/worktrees/` on disk, surfaced through the Rust shell's
// `git_worktrees` command. This file owns the frontend-side state model
// (the in-memory shape, the pending-state machine, and the JSON-shaped
// persistence on disk).
//
// Persistence layout (schemaVersion 2, augments src/projects.ts):
//
//   {
//     "schemaVersion": 2,
//     "projects": [{ id, label, path, lastUsed, uiExpanded?, ... }],
//     "activeId": "…",
//     "activeWorktreeId": "…" | null,
//     "worktreesByProject": {
//        "<projectId>": [{ id, projectId, path, branch, isMain, head?, label? }, …]
//     }
//   }
//
// Pending worktrees (`pendingState in {queued, starting, removing}`) are
// filtered out at save time — they only live in memory while git is doing
// the async `worktree add` or `worktree remove`. Failed worktrees stay
// until the user dismisses them (the row carries Retry / Dismiss actions
// in the sidebar UI).

import { invoke } from "@tauri-apps/api/core";

export type WorktreePendingState =
  | "queued"
  | "starting"
  | "removing"
  | "succeeded"
  | "failed";

export interface Worktree {
  /** Stable frontend-side UUID — survives across `git_worktrees` polls
   *  even when the path was renamed by an external `git` command, since
   *  we re-key by path on each refresh. */
  id: string;
  projectId: string;
  /** Absolute path. */
  path: string;
  /** Short branch name (no `refs/heads/`). `null` for detached HEAD. */
  branch: string | null;
  /** True for the repo's main worktree — can't be removed via UI. */
  isMain: boolean;
  /** Short SHA at HEAD; populated by git_worktrees on each refresh. */
  head?: string;
  locked?: boolean;
  /** Stable chronology for default sorting. Epoch ms; set by Rust when
   *  available and first-seen by the frontend otherwise. */
  createdAt?: number;
  /** User-renameable label; falls back to branch name in the UI. */
  label?: string;
  /** Pending-state machine; absent for fully-live worktrees. */
  pendingState?: WorktreePendingState;
  pendingError?: string;
}

/** Wire shape returned by `git_worktrees`. */
export interface GitWorktreeRecord {
  path: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
  locked: boolean;
  createdAt?: number | null;
}

export type WorktreeSortMode = "newest" | "manual";

function createdAtFor(
  existing: Worktree | undefined,
  rec: GitWorktreeRecord,
  now: number,
): number | undefined {
  if (typeof existing?.createdAt === "number" && Number.isFinite(existing.createdAt)) {
    return existing.createdAt;
  }
  if (typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt)) {
    return rec.createdAt;
  }
  return now;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

/**
 * Reconcile a fresh `git_worktrees` listing against the in-memory store
 * for a single project. The on-disk listing wins for path / branch /
 * head / isMain; existing in-memory entries keep their id, label, and
 * pending state when paths match. Creation-pending entries whose target
 * path now appears in the listing collapse into the matching live row;
 * removing entries stay pending until the background remove finalizes.
 */
export function reconcileWorktrees(
  projectId: string,
  prior: Worktree[],
  listing: GitWorktreeRecord[],
  now = Date.now(),
): Worktree[] {
  const byPath = new Map<string, Worktree>();
  for (const w of prior) {
    byPath.set(w.path, w);
  }
  const out: Worktree[] = [];
  for (const rec of listing) {
    const existing = byPath.get(rec.path);
    if (existing?.pendingState === "removing") {
      out.push({
        ...existing,
        projectId,
        path: rec.path,
        branch: rec.branch,
        isMain: rec.isMain,
        head: rec.head ?? undefined,
        locked: rec.locked || undefined,
        createdAt: createdAtFor(existing, rec, now),
      });
    } else {
      out.push({
        id: existing?.id ?? crypto.randomUUID(),
        projectId,
        path: rec.path,
        branch: rec.branch,
        isMain: rec.isMain,
        head: rec.head ?? undefined,
        locked: rec.locked || undefined,
        createdAt: createdAtFor(existing, rec, now),
        label: existing?.label,
        // Live row — creation pendingState clears on reconcile.
      });
    }
    byPath.delete(rec.path);
  }
  // Preserve unresolved pending rows + any prior worktrees that didn't
  // surface this poll (rare: stale fs cache, external delete). We keep
  // failed pending entries so the user can Dismiss them; queued/starting
  // and removing entries are still in-flight on the bridge.
  for (const w of byPath.values()) {
    if (w.pendingState && w.pendingState !== "succeeded") {
      out.push(w);
    }
  }
  return out;
}

export function newPendingWorktree(
  projectId: string,
  branch: string,
  path: string,
): Worktree {
  return {
    id: crypto.randomUUID(),
    projectId,
    path,
    branch,
    isMain: false,
    pendingState: "queued",
  };
}

export function updateWorktreePendingState(
  list: Worktree[],
  id: string,
  next: WorktreePendingState,
  error?: string,
): Worktree[] {
  return list.map((w) => {
    if (w.id !== id) return w;
    if (next === "succeeded") {
      // Strip pending fields so the row joins the regular list.
      const { pendingState: _p, pendingError: _e, ...rest } = w;
      return rest;
    }
    return { ...w, pendingState: next, pendingError: error };
  });
}

export function removeWorktreeFromList(
  list: Worktree[],
  id: string,
): Worktree[] {
  return list.filter((w) => w.id !== id);
}

/** Drop pending in-flight worktrees before persisting; they should not
 *  outlive the bun process. Failed entries are kept so the user can
 *  Retry / Dismiss on next open. */
export function worktreesForPersist(list: Worktree[]): Worktree[] {
  return list.filter(
    (w) => !w.pendingState || w.pendingState === "failed",
  );
}

export function sortWorktreesNewestFirst(list: readonly Worktree[]): Worktree[] {
  const main = list.filter((w) => w.isMain);
  const extra = list
    .filter((w) => !w.isMain)
    .slice()
    .sort((a, b) => {
      const byCreated = (b.createdAt ?? 0) - (a.createdAt ?? 0);
      if (byCreated !== 0) return byCreated;
      return (a.label ?? a.branch ?? a.path).localeCompare(
        b.label ?? b.branch ?? b.path,
      );
    });
  return [...main, ...extra];
}

export function orderWorktreesForDisplay(
  list: readonly Worktree[],
  mode: WorktreeSortMode | undefined,
): Worktree[] {
  return mode === "manual" ? list.slice() : sortWorktreesNewestFirst(list);
}

export function reorderExtraWorktreeToIndex(
  list: readonly Worktree[],
  worktreeId: string,
  toIndex: number,
): Worktree[] | null {
  if (!worktreeId || !Number.isFinite(toIndex)) return null;
  const main = list.filter((w) => w.isMain);
  const extra = list.filter((w) => !w.isMain);
  const fromIndex = extra.findIndex((w) => w.id === worktreeId);
  if (fromIndex < 0) return null;
  const [moved] = extra.splice(fromIndex, 1);
  const targetIndex = Math.max(0, Math.min(extra.length, Math.trunc(toIndex)));
  extra.splice(targetIndex, 0, moved);
  const next = [...main, ...extra];
  const changed = next.some((w, index) => w.id !== list[index]?.id);
  return changed ? next : null;
}

/* -------------------------------------------------------------------------- */
/* Tauri command bridges                                                       */
/* -------------------------------------------------------------------------- */

export async function gitWorktrees(
  projectPath: string,
): Promise<GitWorktreeRecord[]> {
  return invoke<GitWorktreeRecord[]>("git_worktrees", { projectPath });
}

export async function gitWorktreeAdd(args: {
  projectPath: string;
  targetPath: string;
  branch: string;
  base?: string;
}): Promise<GitWorktreeRecord> {
  return invoke<GitWorktreeRecord>("git_worktree_add", args);
}

export async function gitWorktreeRemove(args: {
  projectPath: string;
  worktreePath: string;
  force?: boolean;
}): Promise<void> {
  await invoke("git_worktree_remove", {
    projectPath: args.projectPath,
    worktreePath: args.worktreePath,
    force: args.force ?? false,
  });
}

/** Recovery path for a worktree git no longer tracks. The Rust command
 *  guards the path (must be a `.git`-marker file pointing into this
 *  project's `.git/worktrees/`) before trashing. */
export async function gitWorktreeRemoveOrphan(args: {
  projectPath: string;
  worktreePath: string;
}): Promise<void> {
  await invoke("git_worktree_remove_orphan", {
    projectPath: args.projectPath,
    worktreePath: args.worktreePath,
  });
}

export async function gitBranchList(
  projectPath: string,
): Promise<GitBranchInfo[]> {
  return invoke<GitBranchInfo[]>("git_branch_list", { projectPath });
}
