/**
 * useEditorExternalChange — surfaces on-disk edits to the open file.
 *
 * Two detection paths share one decision (`checkNow`):
 *   - Fast path: the file-tree's `fs_watch_dirs` watcher emits
 *     `fs-tree-changed` for the open file's directory.
 *   - Robust path: a focus + interval mtime poll, because the shared
 *     watcher only covers the root + *expanded* folders (the Rust watcher
 *     is non-recursive) — a file in a collapsed/hidden folder would
 *     otherwise never be noticed.
 * Either way it re-stats via `fs_file_mtime` and silently reloads a clean
 * buffer or flags a dirty one. The canvas calls `captureBaseline()` after
 * each save/load so self-writes don't trip it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { decideExternalChange, payloadAffectsFile } from "./externalChange";
import type { FsTreeChangedPayload } from "../sidebar/file-tree-watch";

interface UseEditorExternalChangeArgs {
  tabId: string;
  filePath: string;
  root: string;
  /** Live unsaved-state accessor (avoids re-subscribing the listener). */
  isDirtyRef: React.RefObject<boolean>;
  /** Reload the buffer from disk — the same path as the Revert action. */
  reload: () => void;
}

export interface EditorExternalChange {
  externalChanged: boolean;
  /** Re-read mtime as the new baseline and clear the warning. */
  captureBaseline: () => void;
  /** User-triggered reload from disk (reload + re-baseline + clear). */
  reloadExternal: () => void;
}

export function useEditorExternalChange({
  tabId,
  filePath,
  root,
  isDirtyRef,
  reload,
}: UseEditorExternalChangeArgs): EditorExternalChange {
  const [externalChanged, setExternalChanged] = useState(false);
  const baselineRef = useRef(0);
  const filePathRef = useRef(filePath);
  const rootRef = useRef(root);
  const reloadRef = useRef(reload);
  // Keep the refs fresh so the long-lived watcher listener reads the
  // active file without re-subscribing on every render.
  useEffect(() => {
    filePathRef.current = filePath;
    rootRef.current = root;
    reloadRef.current = reload;
  }, [filePath, root, reload]);

  const captureBaseline = useCallback(() => {
    const path = filePathRef.current;
    const r = rootRef.current;
    if (!path || !r) return;
    void invoke<number>("fs_file_mtime", { root: r, path })
      .then((mtime) => {
        baselineRef.current = mtime;
      })
      .catch(() => {
        /* file gone / unreadable — leave baseline, watcher will retry */
      });
    setExternalChanged(false);
  }, []);

  const reloadExternal = useCallback(() => {
    reloadRef.current();
    captureBaseline();
  }, [captureBaseline]);

  // Re-stat the open file and react to a newer mtime. Shared by the
  // watcher fast-path and the focus/interval poll.
  const checkNow = useCallback(() => {
    const path = filePathRef.current;
    const r = rootRef.current;
    if (!path || !r) return;
    void invoke<number>("fs_file_mtime", { root: r, path })
      .then((mtime) => {
        const outcome = decideExternalChange(
          mtime,
          baselineRef.current,
          isDirtyRef.current ?? false,
        );
        if (outcome === "none") return;
        // Bump baseline so the same change can't re-fire.
        baselineRef.current = mtime;
        if (outcome === "reload") reloadRef.current();
        else setExternalChanged(true);
      })
      .catch(() => {
        /* file vanished — a delete surfaces via tab pruning elsewhere */
      });
  }, [isDirtyRef]);

  // Reset + re-baseline whenever the active file (or its root) changes.
  // captureBaseline also clears the externalChanged flag. Keyed on tabId
  // too so switching between two tabs of the same path still re-reads.
  useEffect(() => {
    baselineRef.current = 0;
    captureBaseline();
  }, [tabId, filePath, root, captureBaseline]);

  // Fast path: the shared file-tree watcher. One listener for the canvas
  // lifetime; the refs keep it reading the active file without
  // re-subscribing on every keystroke.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<FsTreeChangedPayload>("fs-tree-changed", (event) => {
      if (disposed) return;
      if (!payloadAffectsFile(event.payload, rootRef.current, filePathRef.current))
        return;
      checkNow();
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [checkNow]);

  // Robust path: poll on window focus + a slow interval, so a file in a
  // collapsed/hidden folder (which the non-recursive tree watcher doesn't
  // cover) still surfaces external edits.
  useEffect(() => {
    const onFocus = () => checkNow();
    window.addEventListener("focus", onFocus);
    const interval = setInterval(checkNow, 15000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, [checkNow]);

  return { externalChanged, captureBaseline, reloadExternal };
}
