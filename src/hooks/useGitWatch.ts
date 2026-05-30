import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * useGitWatch — owns the Rust git-state watcher lifecycle for the active
 * project/worktree root. The watcher watches the resolved git directory
 * (worktree-aware: HEAD/index plus shared refs) and emits `git-state-changed`,
 * which `useVcsStatus` and the file tree listen for to repaint immediately
 * after any git operation — including ones run in an external terminal that
 * only touch `.git/` and so never fire the working-tree `fs-tree-changed`
 * watcher.
 *
 * Lifecycle mirrors `useFileTreeWatch`: start on root change, unwatch the prior
 * root, and unwatch on unmount. All calls are best-effort — a non-repo root is
 * a Rust-side no-op, and a missing git binary degrades silently.
 */
export function useGitWatch(activeRoot: string | null): void {
  const watchedRootRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeRoot) {
      const prev = watchedRootRef.current;
      if (prev) {
        watchedRootRef.current = null;
        void invoke("git_unwatch_root", { root: prev }).catch(() => {
          /* best-effort cleanup */
        });
      }
      return;
    }

    const prev = watchedRootRef.current;
    if (prev && prev !== activeRoot) {
      void invoke("git_unwatch_root", { root: prev }).catch(() => {
        /* best-effort cleanup */
      });
    }
    watchedRootRef.current = activeRoot;
    void invoke("git_watch_root", { root: activeRoot }).catch(() => {
      /* Git watching is an enhancement; the poll backstop still refreshes. */
    });

    return () => {
      void invoke("git_unwatch_root", { root: activeRoot }).catch(() => {
        /* best-effort cleanup */
      });
      if (watchedRootRef.current === activeRoot) {
        watchedRootRef.current = null;
      }
    };
  }, [activeRoot]);
}
