import { useCallback, useEffect, useRef } from "react";
import type { A2UIPayload } from "../types/a2ui";
import { TAB_MIRROR_KEYS } from "./useTabs";
import { WORKSTATION_AREAS, workstationRows } from "./useFocus";
import {
  SESSION_UI_SNAPSHOT_FILE,
  SESSION_UI_SNAPSHOT_FLUSH_EVENT,
  loadSessionUiSnapshot,
  parseSessionUiSnapshot,
  saveSessionUiSnapshot,
  type SessionUiSnapshot,
} from "../state/sessionUiSnapshot";
import { createAppStore, type AppStore } from "../state/appStore";
import { readState, writeState } from "../persist";
import {
  loadLayoutPrefsFromDisk,
  loadLayoutPrefsSync,
  mergeLayoutPrefsIntoState,
  saveLayoutPrefs,
} from "../layoutPrefs";
import { shouldReloadForHmrPayload } from "../utils/hmr";
import { OVERVIEW_TAB_ID, type Tab } from "../types/tab";

export interface BuildInitialAppStoreOptions {
  bootLayout: A2UIPayload;
  logoUrl: string;
  appVersion: string;
}

export interface InitialAppStore {
  appStore: AppStore;
  hasSyncSessionSnapshot: boolean;
}

function restoredActiveTabId(
  tabs: readonly Tab[],
  activeTabId: string | undefined,
): string | null {
  if (activeTabId === OVERVIEW_TAB_ID) return OVERVIEW_TAB_ID;
  if (activeTabId && tabs.some((t) => t.id === activeTabId)) {
    return activeTabId;
  }
  return tabs[0]?.id ?? null;
}

export function buildInitialAppStore({
  bootLayout,
  logoUrl,
  appVersion,
}: BuildInitialAppStoreOptions): InitialAppStore {
  const restored = loadSessionUiSnapshot();
  const layoutPrefs = loadLayoutPrefsSync();
  const tabs = restored?.tabs.length ? restored.tabs : [];
  const activeTabId = restoredActiveTabId(tabs, restored?.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;
  const restoredLayout =
    restored?.layout && typeof restored.layout === "object"
      ? (restored.layout as Record<string, unknown>)
      : {};
  const bootTerminalPanel = bootLayout.state?.terminalPanel;
  const restoredTerminalPanel = restored?.terminalPanel;
  const terminalPanel = {
    ...(bootTerminalPanel && typeof bootTerminalPanel === "object"
      ? bootTerminalPanel
      : {}),
    ...(restoredTerminalPanel && typeof restoredTerminalPanel === "object"
      ? restoredTerminalPanel
      : {}),
    ...(layoutPrefs?.terminalPanel ?? {}),
  } as Record<string, unknown>;
  const bootLayoutState = bootLayout.state?.layout;
  const terminalOpen =
    (restored?.terminal as { open?: boolean } | undefined)?.open ?? false;
  const terminalHeight =
    typeof terminalPanel.height === "number" ? terminalPanel.height : 240;
  const activeRecord =
    (activeTab as unknown as Record<string, unknown> | null) ?? {};
  const rootMirror = Object.fromEntries(
    TAB_MIRROR_KEYS.map((key) => [key, activeRecord[key]]),
  );

  return {
    appStore: createAppStore({
      ...(bootLayout.state ?? {}),
      ...(restored?.terminal ? { terminal: restored.terminal } : {}),
      terminalPanel,
      ...(restored?.scrollToMatchByTab
        ? { scrollToMatchByTab: restored.scrollToMatchByTab }
        : {}),
      ...(restored?.projectModels
        ? { projectModels: restored.projectModels }
        : {}),
      closedSessionIds: restored?.closedSessionIds ?? [],
      sessionUiRestored: Boolean(restored),
      logoUrl,
      appVersion,
      tabs,
      activeTabId,
      // Non-active workspace buckets restored from disk. Set synchronously
      // here so a first persist (which reads state) can't wipe them before
      // the seeding effect copies them into tabBucketsRef.
      persistedTabBuckets: restored?.buckets ?? {},
      ...rootMirror,
      palette: { open: false, mode: "switcher", query: "", selectedIndex: 0 },
      notifications: [],
      sidebar: {
        ...(bootLayout.state?.sidebar as Record<string, unknown> | undefined),
        extensions: [],
      },
      layout: {
        ...(bootLayoutState && typeof bootLayoutState === "object"
          ? bootLayoutState
          : {}),
        ...restoredLayout,
        ...(layoutPrefs?.layout ?? {}),
        rows: workstationRows(terminalOpen, terminalHeight),
        areas: WORKSTATION_AREAS,
      },
    }),
    hasSyncSessionSnapshot: Boolean(restored),
  };
}

export interface UseSessionPersistenceOptions {
  appStore: AppStore;
  hasSyncSessionSnapshot: boolean;
}

export function useSessionPersistence({
  appStore,
  hasSyncSessionSnapshot,
}: UseSessionPersistenceOptions): void {
  const sessionSnapshotPersistTimerRef = useRef<number | null>(null);

  const restoreSessionUiSnapshot = useCallback(
    (snapshot: SessionUiSnapshot) => {
      appStore.setState((prev) => {
        const tabs = snapshot.tabs.length ? snapshot.tabs : [];
        const buckets = snapshot.buckets ?? {};
        const hasBuckets = Object.keys(buckets).length > 0;
        const closedSessionIds = snapshot.closedSessionIds ?? [];
        // Nothing to restore only if BOTH the active workspace and every
        // backgrounded workspace are empty. A buckets-only snapshot (the user
        // closed on an overview while agents ran in workspaces) must still
        // restore its buckets — otherwise the next persist wipes them. A
        // closed-ids-only snapshot still matters too: it suppresses
        // auto-restore for sessions the user explicitly closed.
        if (tabs.length === 0 && !hasBuckets && closedSessionIds.length === 0) {
          return prev;
        }
        const hasActiveTabs = tabs.length > 0;
        const activeTabId = hasActiveTabs
          ? (restoredActiveTabId(tabs, snapshot.activeTabId) ?? tabs[0].id)
          : OVERVIEW_TAB_ID;
        const activeTab = hasActiveTabs
          ? (tabs.find((t) => t.id === activeTabId) ?? tabs[0])
          : undefined;
        const activeRecord =
          (activeTab as unknown as Record<string, unknown>) ?? {};
        const rootMirror = Object.fromEntries(
          TAB_MIRROR_KEYS.map((key) => [key, activeRecord[key]]),
        );
        const restoredLayout =
          snapshot.layout && typeof snapshot.layout === "object"
            ? (snapshot.layout as Record<string, unknown>)
            : {};
        const currentLayout =
          (prev.layout as Record<string, unknown> | undefined) ?? {};
        return {
          ...prev,
          ...(snapshot.terminal ? { terminal: snapshot.terminal } : {}),
          ...(snapshot.terminalPanel
            ? { terminalPanel: snapshot.terminalPanel }
            : {}),
          ...(snapshot.scrollToMatchByTab
            ? { scrollToMatchByTab: snapshot.scrollToMatchByTab }
            : {}),
          ...(snapshot.projectModels
            ? { projectModels: snapshot.projectModels }
            : {}),
          closedSessionIds,
          ...(Object.keys(restoredLayout).length > 0
            ? {
                layout: {
                  ...currentLayout,
                  ...restoredLayout,
                  areas: WORKSTATION_AREAS,
                },
              }
            : {}),
          tabs,
          activeTabId,
          // Restored non-active workspace buckets — the seeding effect
          // hydrates tabBucketsRef from this.
          persistedTabBuckets: buckets,
          empty: !hasActiveTabs,
          hasTabs: hasActiveTabs,
          ...rootMirror,
        };
      });
    },
    [appStore],
  );

  useEffect(() => {
    let cancelled = false;
    let persistenceStarted = false;
    let unsubscribe: (() => void) | undefined;
    const persistNow = () => {
      if (!persistenceStarted) return;
      if (sessionSnapshotPersistTimerRef.current !== null) {
        window.clearTimeout(sessionSnapshotPersistTimerRef.current);
        sessionSnapshotPersistTimerRef.current = null;
      }
      saveSessionUiSnapshot(appStore.getState(), (content) => {
        writeState(SESSION_UI_SNAPSHOT_FILE, content).catch(() => {
          /* persist is best effort */
        });
      });
      saveLayoutPrefs(appStore.getState()).catch(() => {
        /* persist is best effort */
      });
    };
    const schedulePersist = () => {
      if (!persistenceStarted) return;
      if (sessionSnapshotPersistTimerRef.current !== null) {
        window.clearTimeout(sessionSnapshotPersistTimerRef.current);
      }
      sessionSnapshotPersistTimerRef.current = window.setTimeout(() => {
        persistNow();
      }, 100);
    };
    const startPersistence = () => {
      appStore.setState((prev) =>
        prev.sessionUiRestored === true
          ? prev
          : { ...prev, sessionUiRestored: true },
      );
      persistenceStarted = true;
      persistNow();
      unsubscribe = appStore.subscribe(schedulePersist);
      window.addEventListener("beforeunload", persistNow);
      window.addEventListener(SESSION_UI_SNAPSHOT_FLUSH_EVENT, persistNow);
    };
    const hot = import.meta.hot;
    let hmrReloadQueued = false;
    const reloadOnJsUpdate = (payload: unknown) => {
      if (hmrReloadQueued || !shouldReloadForHmrPayload(payload)) return;
      hmrReloadQueued = true;
      persistNow();
      window.setTimeout(() => {
        window.location.reload();
      }, 0);
    };
    hot?.dispose(persistNow);
    hot?.on("vite:beforeUpdate", reloadOnJsUpdate);
    hot?.on("vite:beforeFullReload", persistNow);
    if (hasSyncSessionSnapshot) {
      startPersistence();
    } else {
      readState(SESSION_UI_SNAPSHOT_FILE)
        .then((raw) => {
          if (cancelled) return;
          if (raw !== undefined) {
            const snapshot = parseSessionUiSnapshot(raw, {
              restartShellTabs: false,
            });
            if (snapshot) restoreSessionUiSnapshot(snapshot);
          }
          startPersistence();
        })
        .catch(() => {
          if (!cancelled) startPersistence();
        });
    }
    return () => {
      persistNow();
      cancelled = true;
      unsubscribe?.();
      if (sessionSnapshotPersistTimerRef.current !== null) {
        window.clearTimeout(sessionSnapshotPersistTimerRef.current);
        sessionSnapshotPersistTimerRef.current = null;
      }
      window.removeEventListener("beforeunload", persistNow);
      window.removeEventListener(SESSION_UI_SNAPSHOT_FLUSH_EVENT, persistNow);
      hot?.off("vite:beforeUpdate", reloadOnJsUpdate);
      hot?.off("vite:beforeFullReload", persistNow);
    };
  }, [appStore, hasSyncSessionSnapshot, restoreSessionUiSnapshot]);

  useEffect(() => {
    let cancelled = false;
    void loadLayoutPrefsFromDisk().then((prefs) => {
      if (cancelled || !prefs) return;
      appStore.setState((prev) => mergeLayoutPrefsIntoState(prev, prefs));
    });
    return () => {
      cancelled = true;
    };
  }, [appStore]);
}
