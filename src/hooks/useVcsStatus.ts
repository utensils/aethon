/**
 * useVcsStatus — consolidates working-tree changes, branch ahead/behind,
 * PR state, and CI status for the active project/worktree into a single
 * `/vcs` state slice. Both the header VCS cluster (`vcs-status`) and the
 * source-control panel (`source-control-panel`) read from `/vcs`, so the
 * polling + fan-out lives here in one place.
 *
 * Sources (all best-effort, all degrade silently):
 *   - `git_status`       → branch, ahead, behind, dirty (worktree-aware:
 *                          called against the active root so a worktree's
 *                          own branch is reported, not the project's main).
 *   - `git_file_status`  → per-file change breakdown (count by kind).
 *   - `gh_branch_status` → PRs whose head is this branch (via cache).
 *   - `gh_checks`        → CI / check-run rollup for the branch (via cache).
 *
 * Cadence mirrors `useProjects`: a tick on mount / root change, every 20s,
 * and on window focus. A `cancelled` flag + an in-flight guard keep stale
 * roots from clobbering fresh data and stop overlapping ticks from forking
 * redundant git/gh processes.
 */
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { getGhBranchStatus, type GhPr } from "../ghBranchStatusCache";
import { getGhChecks, type GhCheckRun } from "../ghChecksCache";

type GitFileStatusKind =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "renamed"
  | "copied"
  | "conflicted";

interface GitFileStatusEntry {
  path: string;
  status: GitFileStatusKind;
  originalPath?: string;
}

interface GitStatus {
  branch?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
}

export interface VcsChanges {
  total: number;
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  renamed: number;
  copied: number;
  conflicted: number;
  /** Total inserted / deleted lines vs HEAD (git diff --numstat), for the
   *  `+N -M` stat in the Source Control header. */
  insertions: number;
  deletions: number;
  /** Capped list (most-recent-first as git returns them) for the panel. */
  files: { path: string; status: GitFileStatusKind }[];
}

export interface VcsPr {
  number: number;
  state: string;
  title: string;
  url: string;
  isDraft: boolean;
  merged: boolean;
  baseRefName: string;
}

export interface VcsCi {
  conclusion: string | null;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  checks: GhCheckRun[];
}

export interface VcsSlice {
  root: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  ghAvailable: boolean;
  loading: boolean;
  changes: VcsChanges;
  pr: VcsPr | null;
  ci: VcsCi | null;
}

export interface UseVcsStatusContext {
  /** Active project/worktree cwd (worktree-aware). Null collapses /vcs. */
  activeRoot: string | null;
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
}

const POLL_INTERVAL_MS = 20_000;
/** Keep the panel tidy + the IPC payload small; the count is exact even
 *  when the file list is truncated. */
const MAX_FILES = 200;

const EMPTY_CHANGES: VcsChanges = {
  total: 0,
  modified: 0,
  added: 0,
  deleted: 0,
  untracked: 0,
  renamed: 0,
  copied: 0,
  conflicted: 0,
  insertions: 0,
  deletions: 0,
  files: [],
};

interface DiffStat {
  insertions: number;
  deletions: number;
}

function emptySlice(root: string | null, loading: boolean): VcsSlice {
  return {
    root,
    branch: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    ghAvailable: false,
    loading,
    changes: EMPTY_CHANGES,
    pr: null,
    ci: null,
  };
}

function summariseChanges(
  entries: GitFileStatusEntry[] | null | undefined,
): VcsChanges {
  if (!entries || entries.length === 0) return EMPTY_CHANGES;
  const out: VcsChanges = { ...EMPTY_CHANGES, files: [] };
  for (const e of entries) {
    out.total += 1;
    switch (e.status) {
      case "modified":
        out.modified += 1;
        break;
      case "added":
        out.added += 1;
        break;
      case "deleted":
        out.deleted += 1;
        break;
      case "untracked":
        out.untracked += 1;
        break;
      case "renamed":
        out.renamed += 1;
        break;
      case "copied":
        out.copied += 1;
        break;
      case "conflicted":
        out.conflicted += 1;
        break;
    }
    if (out.files.length < MAX_FILES) {
      out.files.push({ path: e.path, status: e.status });
    }
  }
  return out;
}

/** Pick the PR worth surfacing: an open one first (most recent), then any
 *  recently-closed/merged PR so the chip still shows merge state. */
function pickPr(prs: GhPr[]): VcsPr | null {
  if (!prs || prs.length === 0) return null;
  const open = prs.find((p) => p.state?.toUpperCase() === "OPEN");
  const chosen = open ?? prs[0];
  return {
    number: chosen.number,
    state: chosen.state,
    title: chosen.title,
    url: chosen.url,
    isDraft: chosen.isDraft,
    merged: chosen.merged,
    baseRefName: chosen.baseRefName,
  };
}

export function useVcsStatus({ activeRoot, setState }: UseVcsStatusContext): void {
  useEffect(() => {
    let cancelled = false;
    // In-flight guard is effect-scoped (one per root), NOT a component-wide
    // ref: it dedupes the concurrent mount/interval/focus ticks for THIS
    // root, but must never block the first tick of a freshly-selected root
    // while the previous root's poll is still awaiting git/gh — that would
    // leave the new root's /vcs stuck on the loading shell until the next
    // interval/focus fire.
    let polling = false;
    // Coalesce ticks requested mid-poll. A `git-state-changed` event (or a
    // focus / interval fire) that lands while a poll is in flight would be
    // dropped by the `polling` guard — and if that poll already read git
    // status before the external commit, it writes stale `/vcs` data the
    // fast path never corrects until the next interval. Instead, remember the
    // request and run exactly one follow-up when the current poll settles.
    let rerun = false;

    // The effect re-runs (and cleans up) whenever activeRoot changes, so the
    // `cancelled` flag alone guards against a stale root's late response
    // clobbering the current one — every slice built here carries this
    // effect's captured `activeRoot`.
    const writeSlice = (slice: VcsSlice) => {
      if (cancelled) return;
      setState((s) => ({ ...s, vcs: slice }));
    };

    if (!activeRoot) {
      writeSlice(emptySlice(null, false));
      return;
    }

    // Paint a loading shell immediately so the surfaces don't flash empty
    // while the first round-trip lands.
    setState((s) => {
      const prev = (s.vcs as VcsSlice | undefined) ?? null;
      // Keep prior data for the same root (silent refresh); reset on switch.
      if (prev && prev.root === activeRoot) {
        return { ...s, vcs: { ...prev, loading: true } };
      }
      return { ...s, vcs: emptySlice(activeRoot, true) };
    });

    const tick = async () => {
      if (cancelled) return;
      if (polling) {
        rerun = true;
        return;
      }
      const root = activeRoot;
      polling = true;
      try {
        // Working-tree status + branch (worktree-aware) + change breakdown
        // run together; PR/CI gate on having a branch.
        const [statusRes, filesRes, statRes] = await Promise.all([
          invoke<GitStatus | null>("git_status", { path: root }).catch(
            () => null,
          ),
          invoke<GitFileStatusEntry[] | null>("git_file_status", {
            root,
          }).catch(() => null),
          invoke<DiffStat | null>("git_diff_stat", { root }).catch(() => null),
        ]);

        const branch = statusRes?.branch ?? null;
        // Spread so we never mutate the shared EMPTY_CHANGES constant.
        const changes: VcsChanges = {
          ...summariseChanges(filesRes),
          insertions: statRes?.insertions ?? 0,
          deletions: statRes?.deletions ?? 0,
        };

        let pr: VcsPr | null = null;
        let ci: VcsCi | null = null;
        let ghAvailable = false;
        if (branch) {
          const [branchStatus, checks] = await Promise.all([
            getGhBranchStatus(root, branch).catch(() => null),
            getGhChecks(root, branch).catch(() => null),
          ]);
          if (branchStatus) {
            ghAvailable = branchStatus.ghAvailable;
            pr = pickPr(branchStatus.prs);
          }
          if (checks && checks.ghAvailable) {
            ghAvailable = true;
            ci =
              checks.conclusion && checks.conclusion !== "none"
                ? {
                    conclusion: checks.conclusion,
                    total: checks.total,
                    passed: checks.passed,
                    failed: checks.failed,
                    pending: checks.pending,
                    skipped: checks.skipped,
                    checks: checks.checks,
                  }
                : null;
          }
        }

        writeSlice({
          root,
          branch,
          ahead: statusRes?.ahead ?? 0,
          behind: statusRes?.behind ?? 0,
          dirty: statusRes?.dirty ?? false,
          ghAvailable,
          loading: false,
          changes,
          pr,
          ci,
        });
      } finally {
        polling = false;
        if (rerun && !cancelled) {
          rerun = false;
          void tick();
        }
      }
    };

    void tick();
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => void tick(), POLL_INTERVAL_MS);

    // Event-driven refresh: the Rust git watcher fires `git-state-changed`
    // when this root's `.git/` mutates (commit, stage, branch switch — incl.
    // ones run in an external terminal), so we repaint within a couple hundred
    // milliseconds instead of waiting up to 20s for the next interval tick.
    let unlisten: (() => void) | undefined;
    void listen<{ root: string }>("git-state-changed", (event) => {
      if (cancelled || event.payload.root !== activeRoot) return;
      void tick();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoot]);
}
