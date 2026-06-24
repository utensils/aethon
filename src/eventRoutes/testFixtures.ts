/** Shared fixture for event-route tests. Builds an `EventRouteContext`
 *  whose every method/ref is a `vi.fn()` or a mutable container the
 *  test can introspect. Tests pass an optional override map to swap
 *  individual fields with custom mocks. Mirrors the shape of
 *  `bridgeMessageHandlers/testFixtures.ts` (#36). */
import { vi, type Mock } from "vitest";
import type { MutableRefObject } from "react";
import type { EventRouteContext, DiscoveredSession } from "./types";

const ref = <T>(value: T): MutableRefObject<T> => ({ current: value });

export interface FixtureOverrides {
  state?: Record<string, unknown>;
  extensionRoutes?: { componentId?: string; eventType?: string }[];
  extensionRoutingMode?: "builtin" | "extension";
  pendingShellWriteIds?: string[];
  pendingShellCloseIds?: string[];
  pendingSessionDeleteIds?: string[];
  pendingWorkspacePromptIds?: string[];
  promptDeleteAllow?: boolean;
}

export interface RouteFixture {
  ctx: EventRouteContext;
  mocks: {
    setState: Mock;
    resolveShellWriteConsent: Mock;
    resolveShellCloseConsent: Mock;
    resolveSessionDeleteConsent: Mock;
    resolveWorkspacePrompt: Mock;
    promptDeleteSessionConfirmation: Mock;
    pushNotification: Mock;
    dismissNotification: Mock;
    sendChat: Mock;
    stopPrompt: Mock;
    updateTab: Mock;
    updateActiveTab: Mock;
    editQueuedMessage: Mock;
    deleteQueuedMessage: Mock;
    steerQueuedMessage: Mock;
    clearQueuedMessages: Mock;
    newTab: Mock;
    newShellTab: Mock;
    newEditorTab: Mock;
    updateEditorMeta: Mock;
    toggleEditorPreview: Mock;
    renameEditorTabsForPath: Mock;
    closeEditorTabsForPath: Mock;
    closeTab: Mock;
    closeAllWorkspaceSessions: Mock;
    setActiveTab: Mock;
    activateTabAnywhere: Mock;
    setActiveSubTab: Mock;
    applyShareModeToTab: Mock;
    closeSettings: Mock;
    applySettingsPatch: Mock;
    saveSettings: Mock;
    closeSessionSearch: Mock;
    setSearchQuery: Mock;
    setSearchScope: Mock;
    openSearchHit: Mock;
    closePalette: Mock;
    runPaletteItem: Mock;
    toggleTerminal: Mock;
    clearChat: Mock;
    setModel: Mock;
    setThinkingLevel: Mock;
    setCodexFastMode: Mock;
    setTheme: Mock;
    activateLayoutById: Mock;
    openProjectFromPicker: Mock;
    setActiveProjectById: Mock;
    clearActiveProject: Mock;
    removeProjectById: Mock;
    syncRecentSessionsToState: Mock;
    activateWorkspace: Mock;
    reorderWorkspace: Mock;
    sortProjectWorkspacesNewest: Mock;
    invoke: Mock;
    writeState: Mock;
  };
  /** Apply every queued setState reducer in order against the supplied
   *  seed (or the current stateRef when omitted). */
  applySetState: (seed?: Record<string, unknown>) => Record<string, unknown>;
}

export function buildRouteFixture(
  overrides: FixtureOverrides = {},
): RouteFixture {
  const initialState = overrides.state ?? {};
  const stateRef = ref<Record<string, unknown>>(initialState);

  const setState = vi.fn((arg: unknown) => {
    if (typeof arg === "function") {
      stateRef.current = (
        arg as (p: Record<string, unknown>) => Record<string, unknown>
      )(stateRef.current);
    } else {
      stateRef.current = arg as Record<string, unknown>;
    }
  });

  const pendingWrite = new Set(overrides.pendingShellWriteIds ?? []);
  const pendingClose = new Set(overrides.pendingShellCloseIds ?? []);
  const pendingDelete = new Set(overrides.pendingSessionDeleteIds ?? []);
  const pendingWorkspace = new Set(overrides.pendingWorkspacePromptIds ?? []);

  const resolveShellWriteConsent = vi.fn((id: string, _allowed: boolean) => {
    pendingWrite.delete(id);
  });
  const resolveShellCloseConsent = vi.fn((id: string, _allowed: boolean) => {
    pendingClose.delete(id);
  });
  const resolveSessionDeleteConsent = vi.fn((id: string, _allowed: boolean) => {
    pendingDelete.delete(id);
  });
  const resolveWorkspacePrompt = vi.fn((id: string, _allowed: boolean) => {
    pendingWorkspace.delete(id);
  });
  const promptDeleteSessionConfirmation = vi.fn(() =>
    Promise.resolve(overrides.promptDeleteAllow ?? false),
  );
  const pushNotification = vi.fn();
  const dismissNotification = vi.fn();
  const sendChat = vi.fn(() => Promise.resolve());
  const stopPrompt = vi.fn(() => Promise.resolve());
  const updateTab = vi.fn();
  const updateActiveTab = vi.fn();
  const editQueuedMessage = vi.fn();
  const deleteQueuedMessage = vi.fn();
  const steerQueuedMessage = vi.fn(() => Promise.resolve());
  const clearQueuedMessages = vi.fn();
  const newTab = vi.fn();
  const newShellTab = vi.fn();
  const newEditorTab = vi.fn();
  const updateEditorMeta = vi.fn();
  const toggleEditorPreview = vi.fn();
  const renameEditorTabsForPath = vi.fn();
  const closeEditorTabsForPath = vi.fn();
  const closeTab = vi.fn();
  const closeAllWorkspaceSessions = vi.fn();
  const setActiveTab = vi.fn();
  const activateTabAnywhere = vi.fn();
  const setActiveSubTab = vi.fn();
  const applyShareModeToTab = vi.fn();
  const closeSettings = vi.fn();
  const applySettingsPatch = vi.fn();
  const saveSettings = vi.fn(() => Promise.resolve());
  const closeSessionSearch = vi.fn();
  const setSearchQuery = vi.fn();
  const setSearchScope = vi.fn();
  const openSearchHit = vi.fn();
  const closePalette = vi.fn();
  const runPaletteItem = vi.fn(() => Promise.resolve());
  const toggleTerminal = vi.fn();
  const clearChat = vi.fn();
  const setModel = vi.fn(() => Promise.resolve());
  const setThinkingLevel = vi.fn(() => Promise.resolve());
  const setCodexFastMode = vi.fn(() => Promise.resolve());
  const setTheme = vi.fn();
  const activateLayoutById = vi.fn();
  const openProjectFromPicker = vi.fn(() =>
    Promise.resolve<string | null>(null),
  );
  const setActiveProjectById = vi.fn();
  const clearActiveProject = vi.fn();
  const removeProjectById = vi.fn(() => true);
  const syncRecentSessionsToState = vi.fn();
  const activateWorkspace = vi.fn();
  const reorderWorkspace = vi.fn();
  const sortProjectWorkspacesNewest = vi.fn();
  const invoke = vi.fn(() => Promise.resolve(undefined));
  const writeState = vi.fn(() => Promise.resolve(true));

  const ctx: EventRouteContext = {
    setState,
    stateRef,
    extensionEventRoutesRef: ref(overrides.extensionRoutes ?? []),
    extensionEventRoutingModeRef: ref(
      overrides.extensionRoutingMode ?? "builtin",
    ),
    allDiscoveredSessionsRef: ref<DiscoveredSession[]>([]),
    hasPendingShellWriteConsent: (id: string) => pendingWrite.has(id),
    resolveShellWriteConsent,
    hasPendingShellCloseConsent: (id: string) => pendingClose.has(id),
    resolveShellCloseConsent,
    hasPendingSessionDeleteConsent: (id: string) => pendingDelete.has(id),
    resolveSessionDeleteConsent,
    promptDeleteSessionConfirmation,
    hasPendingWorkspacePrompt: (id: string) => pendingWorkspace.has(id),
    resolveWorkspacePrompt,
    pushNotification,
    dismissNotification,
    sendChat,
    stopPrompt,
    updateTab,
    updateActiveTab,
    editQueuedMessage,
    deleteQueuedMessage,
    steerQueuedMessage,
    clearQueuedMessages,
    newTab,
    newShellTab,
    newEditorTab,
    updateEditorMeta,
    toggleEditorPreview,
    renameEditorTabsForPath,
    closeEditorTabsForPath,
    closeTab,
    closeAllWorkspaceSessions,
    setActiveTab,
    activateTabAnywhere,
    setActiveSubTab,
    applyShareModeToTab,
    closeSettings,
    applySettingsPatch,
    saveSettings,
    closeSessionSearch,
    setSearchQuery,
    setSearchScope,
    openSearchHit,
    closePalette,
    runPaletteItem,
    toggleTerminal,
    clearChat,
    setModel,
    setThinkingLevel,
    setCodexFastMode,
    setTheme,
    activateLayoutById,
    openProjectFromPicker,
    setActiveProjectById,
    clearActiveProject,
    removeProjectById,
    setActiveHost: vi.fn(),
    syncRecentSessionsToState,
    setProjectExpanded: vi.fn(),
    refreshProjectWorkspaces: vi.fn(() => Promise.resolve()),
    activateWorkspace,
    createWorkspaceForProject: vi.fn(() => Promise.resolve()),
    startTaskInProject: vi.fn(() => Promise.resolve()),
    removeWorkspaceById: vi.fn(() => Promise.resolve()),
    dismissPendingWorkspace: vi.fn(),
    retryPendingWorkspace: vi.fn(() => Promise.resolve()),
    renameWorkspace: vi.fn(),
    renameProject: vi.fn(),
    setProjectWorkspaceBaseBranch: vi.fn(),
    reorderWorkspace,
    sortProjectWorkspacesNewest,
    invoke,
    writeState,
  };

  const applySetState = (seed?: Record<string, unknown>) => {
    if (seed === undefined) return stateRef.current;
    let cur = { ...seed };
    for (const call of setState.mock.calls) {
      const arg = call[0];
      if (typeof arg === "function") {
        cur = (arg as (p: Record<string, unknown>) => Record<string, unknown>)(
          cur,
        );
      } else {
        cur = arg as Record<string, unknown>;
      }
    }
    return cur;
  };

  return {
    ctx,
    mocks: {
      setState,
      resolveShellWriteConsent,
      resolveShellCloseConsent,
      resolveSessionDeleteConsent,
      resolveWorkspacePrompt,
      promptDeleteSessionConfirmation,
      pushNotification,
      dismissNotification,
      sendChat,
      stopPrompt,
      updateTab,
      updateActiveTab,
      editQueuedMessage,
      deleteQueuedMessage,
      steerQueuedMessage,
      clearQueuedMessages,
      newTab,
      newShellTab,
      newEditorTab,
      updateEditorMeta,
      toggleEditorPreview,
      renameEditorTabsForPath,
      closeEditorTabsForPath,
      closeTab,
      closeAllWorkspaceSessions,
      setActiveTab,
      activateTabAnywhere,
      setActiveSubTab,
      applyShareModeToTab,
      closeSettings,
      applySettingsPatch,
      saveSettings,
      closeSessionSearch,
      setSearchQuery,
      setSearchScope,
      openSearchHit,
      closePalette,
      runPaletteItem,
      toggleTerminal,
      clearChat,
      setModel,
      setThinkingLevel,
      setCodexFastMode,
      setTheme,
      activateLayoutById,
      openProjectFromPicker,
      setActiveProjectById,
      clearActiveProject,
      removeProjectById,
      syncRecentSessionsToState,
      activateWorkspace,
      reorderWorkspace,
      sortProjectWorkspacesNewest,
      invoke,
      writeState,
    },
    applySetState,
  };
}
