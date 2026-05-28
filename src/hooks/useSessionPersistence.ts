import { useCallback, useEffect, useRef } from "react";
import type { A2UIPayload } from "../types/a2ui";
import { TAB_MIRROR_KEYS } from "./useTabs";
import { WORKSTATION_AREAS, workstationRows } from "./useFocus";
import {
  SESSION_UI_SNAPSHOT_FILE,
  loadSessionUiSnapshot,
  parseSessionUiSnapshot,
  saveSessionUiSnapshot,
  type SessionUiSnapshot,
} from "../state/sessionUiSnapshot";
import { createAppStore, type AppStore } from "../state/appStore";
import { readState, writeState } from "../persist";
import { getConfig } from "../config";
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
      logoUrl,
      appVersion,
      tabs,
      activeTabId,
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
        if (tabs.length === 0) return prev;
        const activeTabId =
          restoredActiveTabId(tabs, snapshot.activeTabId) ?? tabs[0].id;
        const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
        const activeRecord = activeTab as unknown as Record<string, unknown>;
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
          empty: false,
          hasTabs: true,
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
      persistenceStarted = true;
      persistNow();
      unsubscribe = appStore.subscribe(schedulePersist);
      window.addEventListener("beforeunload", persistNow);
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
      getConfig()
        .then((config) => {
          if (cancelled) return;
          if (!config.ui.restoreTabs) {
            startPersistence();
            return;
          }
          return readState(SESSION_UI_SNAPSHOT_FILE);
        })
        .then((raw) => {
          if (cancelled || raw === undefined) return;
          const snapshot = parseSessionUiSnapshot(raw, {
            restartShellTabs: false,
          });
          if (snapshot) restoreSessionUiSnapshot(snapshot);
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
