import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { isRemoteHostId } from "../../../remoteInvoke";
import {
  visibleChangedDirs,
  type FsTreeChangedPayload,
} from "./file-tree-watch";

interface UseFileTreeWatchArgs {
  hostId?: string | null;
  projectPath: string;
  projectPathRef: RefObject<string>;
  refreshFolder: (folderPath: string) => Promise<void>;
  watchedDirs: string[];
}

function useFileTreeWatch({
  hostId,
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
    if (isRemoteHostId(hostId) || !projectPath || watchedDirs.length === 0) {
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
  }, [hostId, projectPath, watchedDirs]);

  useEffect(() => {
    if (!projectPath) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const pendingRefreshDirs = pendingRefreshDirsRef.current;
    const handlePayload = (payload: FsTreeChangedPayload) => {
      if (disposed || payload.root !== projectPathRef.current) return;
      for (const dir of payload.dirs) {
        pendingRefreshDirs.add(dir);
      }
      if (refreshDebounceRef.current) return;
      refreshDebounceRef.current = setTimeout(() => {
        refreshDebounceRef.current = null;
        const dirs = visibleChangedDirs(
          {
            root: payload.root,
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
    };
    const eventName = isRemoteHostId(hostId)
      ? "remote-host-event"
      : "fs-tree-changed";
    void listen<{
      hostId?: string;
      topic?: string;
      payload?: unknown;
      root?: string;
      dirs?: string[];
    }>(eventName, (event) => {
      if (isRemoteHostId(hostId)) {
        if (event.payload.hostId !== hostId || event.payload.topic !== "fs-tree-changed") {
          return;
        }
        const payload = event.payload.payload as FsTreeChangedPayload | undefined;
        if (!payload) return;
        handlePayload(payload);
        return;
      }
      handlePayload(event.payload as FsTreeChangedPayload);
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
  }, [hostId, projectPath, projectPathRef, refreshFolder, watchedDirs]);

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
