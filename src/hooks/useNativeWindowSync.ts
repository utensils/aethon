import {
  useCallback,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Tab } from "../types/tab";
import type { ShareMode } from "../utils/shareMode";
import {
  syncNativeWindowsToState as syncNativeWindowsToStateSlice,
  terminalShellTabIds,
  type NativeCanvasWindowRecord,
  type NativeWindowsRef,
} from "../nativeWindows";

export interface UseNativeWindowSyncContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  nativeWindowsRef: NativeWindowsRef;
}

export function cleanupClosedNativeWindow(
  setState: Dispatch<SetStateAction<Record<string, unknown>>>,
  record: NativeCanvasWindowRecord | undefined,
): void {
  const ownedShellIds = terminalShellTabIds(record);
  if (ownedShellIds.length === 0) return;
  for (const shellId of ownedShellIds) {
    invoke("shell_close", { tabId: shellId }).catch(() => {
      /* best-effort terminal-window cleanup */
    });
  }
  setState((prev) => {
    const tabs = (prev.tabs as Tab[] | undefined) ?? [];
    const owned = new Set(ownedShellIds);
    const panel =
      (prev.terminalPanel as { activeSubId?: string } | undefined) ?? {};
    return {
      ...prev,
      tabs: tabs.filter((tab) => !owned.has(tab.id)),
      ...(panel.activeSubId && owned.has(panel.activeSubId)
        ? { terminalPanel: { ...panel, activeSubId: "agent-bash" } }
        : {}),
    };
  });
}

export function useNativeWindowSync(ctx: UseNativeWindowSyncContext): {
  syncNativeWindowsToState: () => void;
} {
  const { setState, nativeWindowsRef } = ctx;
  const syncNativeWindowsToState = useCallback(() => {
    syncNativeWindowsToStateSlice(setState, nativeWindowsRef);
  }, [setState, nativeWindowsRef]);

  useEffect(() => {
    let disposed = false;
    invoke<NativeCanvasWindowRecord[]>("native_window_list")
      .then((records) => {
        if (disposed || !Array.isArray(records)) return;
        nativeWindowsRef.current = new Map(
          records.map((record) => [record.id, record]),
        );
        syncNativeWindowsToState();
      })
      .catch(() => {
        /* native-window state is best-effort mirror data */
      });
    const unlistenRecord = listen<NativeCanvasWindowRecord>(
      "native-window-record",
      (event) => {
        const record = event.payload;
        if (!record || typeof record.id !== "string") return;
        nativeWindowsRef.current.set(record.id, record);
        syncNativeWindowsToState();
      },
    );
    const unlistenShareMode = listen<{
      tabId?: string;
      shareMode?: ShareMode;
    }>("native-terminal-share-mode", (event) => {
      const { tabId, shareMode } = event.payload ?? {};
      if (typeof tabId !== "string" || typeof shareMode !== "string") return;
      setState((prev) => ({
        ...prev,
        tabs: ((prev.tabs as Tab[] | undefined) ?? []).map((tab) =>
          tab.id === tabId && tab.kind === "shell" && tab.shell
            ? { ...tab, shell: { ...tab.shell, shareMode } }
            : tab,
        ),
      }));
    });
    const unlistenClosed = listen<{ id?: string }>(
      "native-window-closed",
      (event) => {
        const id = event.payload?.id;
        if (typeof id !== "string") return;
        const record = nativeWindowsRef.current.get(id);
        nativeWindowsRef.current.delete(id);
        cleanupClosedNativeWindow(setState, record);
        syncNativeWindowsToState();
      },
    );
    return () => {
      disposed = true;
      unlistenRecord.then((fn) => fn());
      unlistenShareMode.then((fn) => fn());
      unlistenClosed.then((fn) => fn());
    };
  }, [setState, nativeWindowsRef, syncNativeWindowsToState]);

  return { syncNativeWindowsToState };
}
