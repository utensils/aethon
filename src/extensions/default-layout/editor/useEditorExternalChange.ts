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
import { listen } from "@tauri-apps/api/event";
import { safeUnlisten } from "../../../utils/safeUnlisten";

import { invokeForHost, isRemoteHostId } from "../../../remoteInvoke";
import { decideExternalChange, payloadAffectsFile } from "./externalChange";
import { getEditorBuffer } from "../../../monaco/editor-buffers";
import type { FsTreeChangedPayload } from "../sidebar/file-tree-watch";

interface UseEditorExternalChangeArgs {
  tabId: string;
  filePath: string;
  hostId?: string | null;
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
  hostId,
  root,
  isDirtyRef,
  reload,
}: UseEditorExternalChangeArgs): EditorExternalChange {
  const [externalChanged, setExternalChanged] = useState(false);
  const tabIdRef = useRef(tabId);
  const filePathRef = useRef(filePath);
  const rootRef = useRef(root);
  const reloadRef = useRef(reload);
  // Keep the refs fresh so the long-lived watcher listener reads the
  // active file without re-subscribing on every render.
  useEffect(() => {
    tabIdRef.current = tabId;
    filePathRef.current = filePath;
    rootRef.current = root;
    reloadRef.current = reload;
  }, [tabId, filePath, root, reload]);

  // Re-stat the open file and store the result as the buffer baseline,
  // clearing the warning. Called after a save / reload (clean buffer), so
  // a self-write never trips detection. Baseline + flag live on the buffer
  // so they survive a tab switch that remounts the canvas.
  const captureBaseline = useCallback(() => {
    const path = filePathRef.current;
    const r = rootRef.current;
    const tid = tabIdRef.current;
    if (!path || !r) return;
    void invokeForHost<number>(hostId, "fs_file_mtime", { root: r, path })
      .then((mtime) => {
        const buf = getEditorBuffer(tid);
        if (buf) {
          buf.externalBaselineMtime = mtime;
          buf.externalChanged = false;
        }
        if (tabIdRef.current === tid) setExternalChanged(false);
      })
      .catch(() => {
        /* file gone / unreadable — leave baseline, watcher will retry */
      });
  }, [hostId]);

  const reloadExternal = useCallback(() => {
    reloadRef.current();
    captureBaseline();
  }, [captureBaseline]);

  // Re-stat the open file and react to a newer mtime. Shared by the
  // watcher fast-path and the focus/interval poll.
  const checkNow = useCallback(() => {
    const path = filePathRef.current;
    const r = rootRef.current;
    const tid = tabIdRef.current;
    if (!path || !r) return;
    void invokeForHost<number>(hostId, "fs_file_mtime", { root: r, path })
      .then((mtime) => {
        const buf = getEditorBuffer(tid);
        const baseline = buf?.externalBaselineMtime ?? 0;
        const outcome = decideExternalChange(
          mtime,
          baseline,
          isDirtyRef.current ?? false,
        );
        if (outcome === "none") return;
        // Bump baseline so the same change can't re-fire.
        if (buf) buf.externalBaselineMtime = mtime;
        if (outcome === "reload") {
          reloadRef.current();
        } else {
          if (buf) buf.externalChanged = true;
          if (tabIdRef.current === tid) setExternalChanged(true);
        }
      })
      .catch(() => {
        /* file vanished — a delete surfaces via tab pruning elsewhere */
      });
  }, [hostId, isDirtyRef]);

  // On active-file change, restore the buffer's durable warning flag and
  // capture a baseline only the first time we see this buffer — never
  // re-baseline an already-tracked (possibly flagged + dirty) buffer, or
  // the reload affordance would vanish on a tab round-trip.
  useEffect(() => {
    const buf = getEditorBuffer(tabId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror the durable per-buffer flag into render state on active-tab change
    setExternalChanged(buf?.externalChanged ?? false);
    if (!buf || buf.externalBaselineMtime === undefined) captureBaseline();
  }, [tabId, filePath, root, captureBaseline]);

  // Fast path: the shared file-tree watcher. One listener for the canvas
  // lifetime; the refs keep it reading the active file without
  // re-subscribing on every keystroke.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const eventName = isRemoteHostId(hostId)
      ? "remote-host-event"
      : "fs-tree-changed";
    void listen<{
      hostId?: string;
      topic?: string;
      payload?: unknown;
    }>(eventName, (event) => {
      if (disposed) return;
      const payload = isRemoteHostId(hostId)
        ? event.payload.hostId === hostId && event.payload.topic === "fs-tree-changed"
          ? (event.payload.payload as FsTreeChangedPayload | undefined)
          : undefined
        : (event.payload as FsTreeChangedPayload);
      if (!payload) return;
      if (!payloadAffectsFile(payload, rootRef.current, filePathRef.current))
        return;
      checkNow();
    }).then((fn) => {
      if (disposed) {
        safeUnlisten(fn);
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      if (unlisten) safeUnlisten(unlisten);
    };
  }, [checkNow, hostId]);

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
