import { useEffect, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  loadCachedStatuses,
  persistStatusesDebounced,
} from "../gitStatusCache";
import {
  loadGitFetchAttempts,
  persistGitFetchAttemptsDebounced,
} from "../gitFetchCache";
import {
  dueGitFetchPaths,
  GIT_FETCH_INTERVAL_MS,
} from "./gitFetchScheduler";
import { dueStatusRoots, warmStatusRoots } from "./statusPollScheduler";
import { scheduleAfterMobileBootWindow } from "./mobileBootDefer";

export interface GitStatus {
  branch?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
}

/** Field-wise equality so an idle poll tick that returns the same status
 *  doesn't notify (each notify is a full sidebar mirror + full-tree React
 *  render — up to one per project per 30s tick before this diff). */
export function gitStatusEquals(
  a: GitStatus | undefined,
  b: GitStatus | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.branch === b.branch &&
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind
  );
}

export interface UseProjectsContext {
  /** Returns the absolute paths of every known project. The git poller
   *  iterates this on every tick. Callback rather than a static prop so
   *  the hook always sees the live list when the user adds or removes
   *  projects without re-instantiating. */
  getProjectPaths: () => string[];
  /** Fired whenever a project's git status changes (a poll updated the
   *  cache). App.tsx wires this to `syncProjectsToState` so the
   *  /sidebar/projects badges refresh. */
  onGitStatusChanged: () => void;
}

export interface UseProjectsActions {
  /** Cached git status keyed by absolute project path. Read by the
   *  caller's syncProjectsToState when mirroring into /sidebar/projects. */
  gitStatusRef: MutableRefObject<Map<string, GitStatus>>;
  /** Refresh git status for one project path. Best-effort — a missing
   *  `git` binary or a non-repo path resolves to an empty cache entry. */
  refreshGitStatusFor: (path: string) => Promise<void>;
  /** Sequenced git refresh across every known project (max 16). */
  refreshAllGitStatus: () => Promise<void>;
  /** Tell the bridge what cwd to use for new sessions on a tab.
   *  Fire-and-forget; the bridge re-announces on next tab_open. */
  announceProjectToBridge: (tabId: string, cwd: string | null) => void;
  /** Tell the Rust shell to start watching this project's
   *  `.aethon/extensions/` for hot-reload. Pairs with announceProject. */
  watchProjectForBridge: (path: string) => void;
  /** Stop watching a project's extensions dir (idempotent on Rust side). */
  unwatchProjectForBridge: (path: string) => void;
}

/**
 * Project-scoped I/O: git status polling, bridge IPC for cwd + extension
 * watching, and the git status cache. Project list state itself
 * (projectsRef, tabBucketsRef, projectsLoadedRef) stays in App.tsx for
 * now — those are entangled with tab management and will move when
 * useTabs is extracted in a follow-up.
 *
 * The git status poller ticks immediately on mount, every 30s, and on window
 * focus — but each tick only refreshes roots whose tier cadence elapsed
 * (statusPollScheduler: warm = recently activated workspaces at 60s, cold =
 * everything else at 5min; the active workspace is the hot tier owned by
 * useVcsStatus). Remote-tracking refs are refreshed on a separate 10-minute
 * cadence with persisted attempt timestamps so ahead/behind can catch up
 * without hammering remotes after reloads or repeated focus toggles. Guard
 * refs prevent overlapping refresh/fetch batches from forking redundant git
 * processes.
 */
export function useProjects(ctx: UseProjectsContext): UseProjectsActions {
  const gitStatusRef = useRef<Map<string, GitStatus>>(new Map());
  const gitPollingRef = useRef(false);
  const gitFetchAttemptsRef = useRef<Map<string, number>>(new Map());
  const gitFetchInFlightRef = useRef<Set<string>>(new Set());
  /** Last completed git_status refresh per root — the tiered scheduler's
   *  cadence state (see statusPollScheduler). */
  const statusPolledAtRef = useRef<Map<string, number>>(new Map());

  /** Refresh the cache entry for one path. Returns true when the status
   *  actually changed; does NOT notify — callers decide whether to fan
   *  out (single refresh notifies per call, the poll batch notifies once). */
  async function refreshStatusEntry(path: string): Promise<boolean> {
    try {
      const status = await invoke<GitStatus | null>("git_status", { path });
      const prev = gitStatusRef.current.get(path);
      if (status) {
        if (gitStatusEquals(prev, status)) return false;
        gitStatusRef.current.set(path, status);
      } else {
        if (!prev) return false;
        gitStatusRef.current.delete(path);
      }
      return true;
    } catch {
      // Tauri command threw — ignore so a transient git failure doesn't
      // blank the chip on subsequent successful polls.
      return false;
    }
  }

  async function refreshGitStatusFor(path: string): Promise<void> {
    const changed = await refreshStatusEntry(path);
    statusPolledAtRef.current.set(path, Date.now());
    if (changed) {
      ctx.onGitStatusChanged();
      // Persist (debounced) so the next cold start can paint chips
      // instantly from disk before any subprocess runs.
      persistStatusesDebounced(gitStatusRef.current);
    }
  }

  /** Refresh a batch of roots: parallel subprocesses (bounded — the
   *  project list caps at 16), one notification per batch when anything
   *  changed, and a cadence stamp per root for the tiered scheduler. */
  async function refreshStatusBatch(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const changed = await Promise.all(paths.map((p) => refreshStatusEntry(p)));
    const now = Date.now();
    for (const p of paths) statusPolledAtRef.current.set(p, now);
    // One notification per batch: an idle tick (nothing changed) renders
    // nothing; a busy tick costs one sidebar mirror instead of sixteen.
    if (changed.some(Boolean)) {
      ctx.onGitStatusChanged();
      persistStatusesDebounced(gitStatusRef.current);
    }
  }

  /** Uncadenced full sweep across every known project. Used after a git
   *  fetch (remote refs moved for every fetched repo) and exposed to
   *  callers; the periodic poll goes through the tiered scheduler. */
  async function refreshAllGitStatus(): Promise<void> {
    await refreshStatusBatch(ctx.getProjectPaths());
  }

  /** Scheduler-driven refresh: only roots whose tier cadence elapsed.
   *  Warm tier = recently activated workspace roots (MRU recorded by the
   *  activation paths); cold tier = all known project paths. The active
   *  workspace itself is the hot tier, owned by useVcsStatus. */
  async function refreshDueGitStatus(): Promise<void> {
    await refreshStatusBatch(
      dueStatusRoots({
        coldRoots: ctx.getProjectPaths(),
        warmRoots: warmStatusRoots(),
        lastPolledAt: statusPolledAtRef.current,
      }),
    );
  }

  async function fetchGitRemotesIfDue(
    refreshStatusAfterFetch = refreshAllGitStatus,
  ): Promise<void> {
    if (document.hidden) return;
    const due = dueGitFetchPaths(ctx.getProjectPaths(), {
      lastAttemptedAt: gitFetchAttemptsRef.current,
      inFlight: gitFetchInFlightRef.current,
    });
    if (due.length === 0) return;

    const startedAt = Date.now();
    for (const path of due) {
      gitFetchInFlightRef.current.add(path);
      gitFetchAttemptsRef.current.set(path, startedAt);
    }
    persistGitFetchAttemptsDebounced(gitFetchAttemptsRef.current);

    const results = await Promise.all(
      due.map(async (path) => {
        try {
          return await invoke<boolean>("git_fetch_all", { projectPath: path });
        } catch {
          return false;
        } finally {
          gitFetchInFlightRef.current.delete(path);
        }
      }),
    );

    // Fetches may mutate remote-tracking refs even when one remote exits
    // nonzero. Once any fetch ran, force the fetched roots stale so the
    // follow-up refresh (which may go through the tiered scheduler) picks
    // them up regardless of cadence, then run the status fan-out so every
    // surface that reads cached git status (including duplicate workspace
    // rows) gets refreshed from local metadata.
    if (results.some(Boolean)) {
      for (const path of due) statusPolledAtRef.current.delete(path);
      await refreshStatusAfterFetch();
    }
  }

  function announceProjectToBridge(tabId: string, cwd: string | null) {
    invoke("agent_command", {
      payload: JSON.stringify({ type: "set_project", tabId, cwd }),
    }).catch(() => {
      /* bridge gone — next tab_open re-announces */
    });
  }

  function watchProjectForBridge(path: string) {
    invoke("watch_project_extensions", { projectPath: path }).catch(
      (err: unknown) => {
        console.warn("[aethon] watch_project_extensions failed:", err);
      },
    );
  }

  function unwatchProjectForBridge(path: string) {
    invoke("unwatch_project_extensions", { projectPath: path }).catch(
      (err: unknown) => {
        console.warn("[aethon] unwatch_project_extensions failed:", err);
      },
    );
  }

  useEffect(() => {
    let cancelled = false;
    let rerun = false;
    let cancelBootDefer: () => void = () => {};
    const tick = async () => {
      // Skip background git polling while the window is hidden — no chips are
      // visible to update, so it's pure wasted subprocess churn. The
      // visibilitychange listener below refreshes on the way back.
      if (cancelled || document.hidden) return;
      if (gitPollingRef.current) {
        rerun = true;
        return;
      }
      gitPollingRef.current = true;
      try {
        await refreshDueGitStatus();
      } finally {
        gitPollingRef.current = false;
        if (rerun && !cancelled) {
          rerun = false;
          void tick();
        }
      }
    };
    // 1. Hydrate from the disk-backed cache so chips paint with the
    //    last-known status before any subprocess runs. 2. Kick off the
    //    background refresh so anything that drifted since the last
    //    persist catches up. The two phases are independent — a slow
    //    refresh doesn't gate the cached paint.
    const bootstrap = async () => {
      const cached = await loadCachedStatuses();
      if (cancelled) return;
      if (cached.size > 0) {
        for (const [path, status] of cached) {
          gitStatusRef.current.set(path, status);
        }
        ctx.onGitStatusChanged();
      }
      gitFetchAttemptsRef.current = await loadGitFetchAttempts();
      if (cancelled) return;
      // Desktop: refresh immediately. Mobile companion: the cached
      // hydrate above already painted the chips — defer the first live
      // per-project poll past the boot window so it doesn't compete
      // with hydration for the gateway's invoke budget.
      cancelBootDefer = scheduleAfterMobileBootWindow(() => {
        if (cancelled) return;
        void tick();
        void fetchGitRemotesIfDue(tick);
      });
    };
    void bootstrap();
    const onFocus = () => {
      void tick();
      void fetchGitRemotesIfDue(tick);
    };
    // Refresh when the window becomes visible again (covers restore-from-
    // minimized, which doesn't always fire `focus`), catching up on anything
    // that drifted while polling was paused.
    const onVisibility = () => {
      if (!document.hidden) {
        void tick();
        void fetchGitRemotesIfDue(tick);
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(tick, 30_000);
    const fetchInterval = window.setInterval(
      () => void fetchGitRemotesIfDue(tick),
      GIT_FETCH_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      cancelBootDefer();
      window.clearInterval(interval);
      window.clearInterval(fetchInterval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // ctx.getProjectPaths is read inside `tick` / `fetchGitRemotesIfDue`,
    // so we deliberately capture the closure-time reference; the hook is mounted once with
    // a stable ctx for App's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    gitStatusRef,
    refreshGitStatusFor,
    refreshAllGitStatus,
    announceProjectToBridge,
    watchProjectForBridge,
    unwatchProjectForBridge,
  };
}
