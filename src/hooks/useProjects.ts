import { useEffect, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface GitStatus {
  branch?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
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
 * The git poller ticks immediately on mount, every 30s, and on window
 * focus. A guard ref prevents two overlapping refreshes from running
 * (a long projects list could otherwise fork dozens of git processes
 * on rapid focus toggles).
 */
export function useProjects(ctx: UseProjectsContext): UseProjectsActions {
  const gitStatusRef = useRef<Map<string, GitStatus>>(new Map());
  const gitPollingRef = useRef(false);

  async function refreshGitStatusFor(path: string): Promise<void> {
    try {
      const status = await invoke<GitStatus | null>("git_status", { path });
      if (status) {
        gitStatusRef.current.set(path, status);
      } else {
        gitStatusRef.current.delete(path);
      }
      ctx.onGitStatusChanged();
    } catch {
      // Tauri command threw — ignore so a transient git failure doesn't
      // blank the chip on subsequent successful polls.
    }
  }

  async function refreshAllGitStatus(): Promise<void> {
    const paths = ctx.getProjectPaths();
    for (const p of paths) {
      await refreshGitStatusFor(p);
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
    const tick = async () => {
      if (cancelled || gitPollingRef.current) return;
      gitPollingRef.current = true;
      try {
        await refreshAllGitStatus();
      } finally {
        gitPollingRef.current = false;
      }
    };
    void tick();
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
    // ctx.getProjectPaths is read inside `tick`, so we deliberately
    // capture the closure-time reference; the hook is mounted once with
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
