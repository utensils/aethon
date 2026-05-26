import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  visibleChangedDirs,
  type FsTreeChangedPayload,
} from "./file-tree-watch";

interface UseFileTreeWatchArgs {
  projectPath: string;
  projectPathRef: RefObject<string>;
  refreshFolder: (folderPath: string) => Promise<void>;
  watchedDirs: string[];
}

function useFileTreeWatch({
  projectPath,
  projectPathRef,
  refreshFolder,
  watchedDirs,
}: UseFileTreeWatchArgs) {
  const watchSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchedRootRef = useRef<string>("");
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRefreshDirsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (watchSyncTimerRef.current) clearTimeout(watchSyncTimerRef.current);
    const previousRoot = watchedRootRef.current;
    if (!projectPath || watchedDirs.length === 0) {
      if (previousRoot) {
        watchedRootRef.current = "";
        void invoke("fs_unwatch_root", { root: previousRoot }).catch(() => {
          /* best-effort cleanup */
        });
      }
      return;
    }
    watchedRootRef.current = projectPath;
    watchSyncTimerRef.current = setTimeout(() => {
      if (previousRoot && previousRoot !== projectPath) {
        void invoke("fs_unwatch_root", { root: previousRoot }).catch(() => {
          /* best-effort cleanup */
        });
      }
      void invoke("fs_watch_dirs", {
        root: projectPath,
        dirs: watchedDirs,
      }).catch(() => {
        /* File watching is an enhancement; manual tree ops still refresh. */
      });
    }, 150);
    return () => {
      if (watchSyncTimerRef.current) {
        clearTimeout(watchSyncTimerRef.current);
        watchSyncTimerRef.current = null;
      }
    };
  }, [projectPath, watchedDirs]);

  useEffect(() => {
    if (!projectPath) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const pendingRefreshDirs = pendingRefreshDirsRef.current;
    void listen<FsTreeChangedPayload>("fs-tree-changed", (event) => {
      if (disposed || event.payload.root !== projectPathRef.current) return;
      for (const dir of event.payload.dirs) {
        pendingRefreshDirs.add(dir);
      }
      if (refreshDebounceRef.current) return;
      refreshDebounceRef.current = setTimeout(() => {
        refreshDebounceRef.current = null;
        const dirs = visibleChangedDirs(
          {
            root: event.payload.root,
            dirs: [...pendingRefreshDirs],
          },
          projectPathRef.current,
          watchedDirs,
        );
        pendingRefreshDirs.clear();
        for (const dir of dirs) {
          void refreshFolder(dir);
        }
      }, 120);
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
        refreshDebounceRef.current = null;
      }
      pendingRefreshDirs.clear();
      unlisten?.();
    };
  }, [projectPath, projectPathRef, refreshFolder, watchedDirs]);

  useEffect(() => {
    return () => {
      const rootToUnwatch = watchedRootRef.current;
      if (rootToUnwatch) {
        void invoke("fs_unwatch_root", { root: rootToUnwatch }).catch(() => {
          /* best-effort cleanup */
        });
      }
      if (watchSyncTimerRef.current) clearTimeout(watchSyncTimerRef.current);
      if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
    };
  }, []);
}

export { useFileTreeWatch };
