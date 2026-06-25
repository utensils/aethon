import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExtensionRegistry } from "./extensions/ExtensionRegistry";
import { defaultLayoutExtension } from "./extensions/default-layout";
import { AppRoot } from "./app/AppRoot";
import { BOOT_LAYOUT, hangWarnNotifId } from "./app/bootConstants";
import { useAppForwardRefs } from "./app/useAppForwardRefs";
import { useAppInteractions } from "./app/useAppInteractions";
import { useAppRuntimeSurfaces } from "./app/useAppRuntimeSurfaces";
import type { A2UIPayload } from "./types/a2ui";
import type { Tab } from "./types/tab";
import { useZoomAndTheme } from "./hooks/useZoomAndTheme";
import { useSpeakReplies } from "./hooks/useSpeakReplies";
import { useShellConsent } from "./hooks/useShellConsent";
import { useHostInfo } from "./hooks/useHostInfo";
import { useDevshell, type DevshellEntry } from "./hooks/useDevshell";
import { useProjects } from "./hooks/useProjects";
import { useAgentWorkerReconcile } from "./hooks/useAgentWorkerReconcile";
import { useAgentActivityHydration } from "./hooks/useAgentActivityHydration";
import { useVcsStatus } from "./hooks/useVcsStatus";
import { useGitWatch } from "./hooks/useGitWatch";
import { useTabNavigation } from "./hooks/useTabNavigation";
import { useTabs } from "./hooks/useTabs";
import { useRestoreShellTabs } from "./hooks/useRestoreShellTabs";
import { useExtensionsHydration } from "./hooks/useExtensionsHydration";
import { useBootConfig } from "./hooks/useBootConfig";
import { useNotifications } from "./hooks/useNotifications";
import { useWorkspacePrompts } from "./hooks/useWorkspacePrompts";
import { useFocus } from "./hooks/useFocus";
import { useChat } from "./hooks/useChat";
import { useQueuedDispatch } from "./hooks/useQueuedDispatch";
import { useControlRequests } from "./hooks/useControlRequests";
import { useUiOverlays } from "./hooks/useUiOverlays";
import { useUpdater } from "./hooks/useUpdater";
import { useWorkspaceStartup } from "./hooks/useWorkspaceStartup";
import { UpdateBanner } from "./components/UpdateBanner";
import { useProjectOps } from "./hooks/useProjectOps";
import type { TabBucket } from "./hooks/projectOps/types";
import {
  buildInitialAppStore,
  useSessionPersistence,
} from "./hooks/useSessionPersistence";
import { useDerivedRenderState } from "./hooks/useDerivedRenderState";
import { useTabBucketHydration } from "./hooks/useTabBucketHydration";
import { useTaskLauncher } from "./hooks/useTaskLauncher";
import { useRoutedTabHelpers } from "./hooks/useRoutedTabHelpers";
import { useAppStateRefs } from "./hooks/useAppStateRefs";
import { useProjectModelRecorder } from "./hooks/useProjectModelRecorder";
import { useProjectSyncEffects } from "./hooks/useProjectSyncEffects";
import { useAppSlashCommandContext } from "./hooks/useAppSlashCommandContext";
import { useAppBridgeMessages } from "./hooks/useAppBridgeMessages";
import { useScheduledTasks } from "./hooks/useScheduledTasks";
import { useNativeWindowSync } from "./hooks/useNativeWindowSync";
import { useRootChromeActions } from "./hooks/useRootChromeActions";
import { useActivateTabAnywhere } from "./hooks/useActivateTabAnywhere";
import { useUpdaterConfigBridge } from "./hooks/useUpdaterConfigBridge";
import { closeAllWorkspaceSessions } from "./hooks/tabOps/closeWorkspaceSessions";
import type { NativeCanvasWindowRecord } from "./nativeWindows";
import { writeState } from "./persist";
import { useAppState } from "./state/appStore";
import { activeWorkspaceCwd } from "./utils/activeWorkspaceRoot";
import pkg from "../package.json" with { type: "json" };
// Vite resolves `?url` imports to a hashed asset URL at build time. Injecting
// the URL into layout state lets the header bind via `{"$ref": "/logoUrl"}`
// instead of hardcoding a path that might 404 in a production bundle.
import logoUrl from "./assets/aethon-logo.svg?url";

export default function App() {
  // The registry is created once and shared across the app via context.
  // Extensions register their components/layouts here; the renderer resolves
  // unknown component types through it.
  const [registry] = useState<ExtensionRegistry>(() => {
    const r = new ExtensionRegistry();
    r.register(defaultLayoutExtension);
    return r;
  });

  // ---------------------------------------------------------------------
  // Multi-tab model. Each tab owns its own `messages`, `draft`, `waiting`,
  // `queueCount`, and `canvas`. The active tab's view is mirrored to the
  // top-level state keys (`/messages`, `/draft`, etc.) so the existing
  // layout JSON bindings keep working without a per-tab JSON Pointer
  // rewrite. On tab switch we re-mirror the new active tab's view; on
  // every per-tab update we write the tab record AND, if it's active,
  // also write the root mirror. Tab/ShellMeta types live in
  // src/types/tab.ts.
  // ---------------------------------------------------------------------
  // The layout's state IS the app state. Single source of truth, addressed by
  // JSON Pointer from the layout payload. We seed `logoUrl` here so the header
  // can $ref it without the layout JSON having to know the hashed asset path.
  // Initial state has NO tabs by default — the projects-dashboard is the
  // canvas until the user opens a project or clicks "New Tab". A restored
  // session snapshot rehydrates whatever tabs were open last; a fresh boot
  // (or `dev --new`) lands on the dashboard with the canvas empty.
  const initialApp = useMemo(
    () =>
      buildInitialAppStore({
        bootLayout: BOOT_LAYOUT,
        logoUrl,
        // App version surfaced as a state slice so layout JSON can $ref it.
        appVersion: `v${pkg.version}`,
      }),
    [],
  );
  const { appStore, hasSyncSessionSnapshot } = initialApp;
  const state = useAppState(appStore, (s) => s);
  const setState = appStore.setState;
  const nativeWindowsRef = useRef<Map<string, NativeCanvasWindowRecord>>(
    new Map(),
  );
  const tabBucketsRef = useRef<Map<string, TabBucket>>(new Map());

  // Active layout payload — replaceable. Extensions can swap the chrome wholesale
  // by calling window.aethon.setLayout(payload), or register a new extension via
  // window.aethon.registerExtension(extension) and switch to its layout.
  const [layout, setLayout] = useState<A2UIPayload>(BOOT_LAYOUT);
  const [startupChromeReady, setStartupChromeReady] = useState(false);
  const {
    stateRef,
    projectsRef,
    piDefaultModelRef,
    hangWarnActiveRef,
    hangWarnTimersRef,
    projectOpsHandleRef,
    projectsHandleRef,
    pushNotificationRef,
    chatActionsRef,
  } = useAppStateRefs(appStore);

  const { syncNativeWindowsToState } = useNativeWindowSync({
    setState,
    nativeWindowsRef,
  });

  const {
    view: workspaceStartupView,
    prepareWorkspaceStartup,
    approveStartup,
    retryStartup,
    continueStartup,
  } = useWorkspaceStartup({ state, setState, stateRef });

  useSessionPersistence({ appStore, hasSyncSessionSnapshot });
  useAgentActivityHydration(setState);

  const recordProjectModel = useProjectModelRecorder(setState);

  // ---------------------------------------------------------------------
  // Boot config: read ~/.aethon/config.toml + persisted theme/zoom/sidebar
  // state from disk and seed live config refs. `reapplyConfig` is the
  // settings save path's re-prime helper.
  // ---------------------------------------------------------------------
  const {
    bootConfigReady,
    defaultShareModeRef,
    notifyOnCompletionRef,
    notifyMinDurationMsRef,
    autoRestartAgentRef,
    shellDefaultCommandRef,
    shellDefaultArgsRef,
    shellInheritEnvRef,
    shellPromptBeforeCloseRef,
    reapplyConfig,
  } = useBootConfig({ setState, piDefaultModelRef });

  // ---------------------------------------------------------------------
  // UI zoom + theme switching are owned by useZoomAndTheme. The hook
  // also installs a window resize listener that re-syncs the viewport
  // CSS vars so layout-sized children stay aligned at non-1.0 zoom.
  // ---------------------------------------------------------------------
  const { adjustZoom, resetZoom, setTheme } = useZoomAndTheme({
    setState,
    pushNotification: (n) => pushNotificationRef.current(n),
  });

  // Shell consent flow (Allow/Deny prompts for agent shell writes,
  // close-shell confirmations, and session deletions) lives in
  // useShellConsent. Each prompt resolves its Promise via an action
  // route handler on the notification.
  const {
    resolveShellWriteConsent,
    resolveShellCloseConsent,
    resolveSessionDeleteConsent,
    hasPendingShellWriteConsent,
    hasPendingShellCloseConsent,
    hasPendingSessionDeleteConsent,
    promptCloseShellTabConfirmation,
    promptDeleteSessionConfirmation,
    routeShellWrite,
  } = useShellConsent({
    pushNotification: (n) => pushNotificationRef.current(n),
    stateRef,
  });

  const workspacePrompts = useWorkspacePrompts({
    pushNotification: (n) => pushNotificationRef.current(n),
  });

  // ---------------------------------------------------------------------
  // Project I/O (git status polling, bridge IPC for cwd + extension
  // watching). The hook owns the gitStatusRef cache, the 30s poll
  // effect, and announce/watch/unwatch invokes.
  // ---------------------------------------------------------------------
  const {
    gitStatusRef,
    refreshGitStatusFor,
    refreshAllGitStatus,
    announceProjectToBridge,
    watchProjectForBridge,
    unwatchProjectForBridge,
  } = useProjects({
    getProjectPaths: () => projectsHandleRef.current.getPaths(),
    onGitStatusChanged: () => projectsHandleRef.current.onGitStatusChanged(),
  });

  // Host info (local + LAN-discovered) — drives the HOSTS sidebar
  // section and the dashboard host banner. Stays passive: hosts come
  // from Tauri events; the active host is a user-driven selection.
  const hostInfo = useHostInfo();

  // Active workspace root. Root derivation mirrors the file tree
  // (file-tree.tsx): the active workspace path when one is selected, else the
  // active project's path, else the active editor tab's root — so devshell,
  // VCS, and tree decoration all point at the same cwd.
  const activeWorkspaceRoot = activeWorkspaceCwd(state);

  // Devshell badge wiring. Track the current project root; the hook
  // hydrates the chip from the Rust cache on switch and stays in
  // sync via the Tauri `devshell-*` events. Events are also
  // forwarded into the agent so the bash-tool spawnHook's cache
  // stays warm without polling.
  useDevshell({
    activeRoot: activeWorkspaceRoot,
    setDevshellEntry: (root, patch) => {
      setState((s) => {
        const prev =
          (s.devshell as { entries?: Record<string, DevshellEntry> }) ?? {};
        const entries = { ...(prev.entries ?? {}) };
        // Merge the patch over the previous entry so resolver-event
        // updates (which only carry kind/state/timings) don't clobber
        // config-derived fields like `enabled` / `mode` populated by
        // the initial `devshell_status` hydration.
        const existing: DevshellEntry = entries[root] ?? {
          kind: null,
          detectedKind: null,
          enabled: "auto",
          mode: "auto",
          state: "none",
        };
        entries[root] = { ...existing, ...patch };
        return { ...s, devshell: { ...prev, entries } };
      });
    },
    setDevshellActive: (root) => {
      setState((s) => {
        const prev = (s.devshell as { activeRoot?: string | null }) ?? {};
        return { ...s, devshell: { ...prev, activeRoot: root } };
      });
    },
  });

  // VCS surface wiring. Polls working-tree changes + PR + CI status for the
  // active project/workspace root into the `/vcs` slice, consumed by the
  // header `vcs-status` cluster and the `source-control-panel` above the
  // file tree. The file tree's final `~/.aethon` fallback is intentionally
  // omitted: it is never a git repo, so `/vcs` would collapse anyway, and
  // replicating the async home-dir fetch here is noise.
  useVcsStatus({ activeRoot: activeWorkspaceRoot, setState });
  useGitWatch(activeWorkspaceRoot);

  // ---------------------------------------------------------------------
  // Tab lifecycle (create / switch / update / close / undo-close), the
  // sub-tab switcher, the shell-/agent-tab-active mirror effect, and the
  // terminal replay dispatch all live in useTabs. The hook keeps closed-
  // tab + auto-restore + pending-tab-open state internally.
  // ---------------------------------------------------------------------
  const {
    pendingTabOpens,
    updateTab,
    updateActiveTab,
    applyShareModeToTab,
    dispatchTerminalReplay,
    setActiveTab,
    setActiveSubTab,
    newTab,
    newShellTab,
    newEditorTab,
    updateEditorMeta,
    toggleEditorPreview,
    renameEditorTabsForPath,
    closeEditorTabsForPath,
    autoRestoreDiscoveredSessions,
    reopenLastClosedTab,
    closeTab,
    closeTabNow,
  } = useTabs({
    setState,
    stateRef,
    pushNotification: (n) => pushNotificationRef.current(n),
    appendSystem: (text) => chatActionsRef.current.appendSystem(text),
    promptCloseShellTabConfirmation,
    projectsRef,
    tabBucketsRef,
    piDefaultModelRef,
    clearActiveProject: () => projectOpsHandleRef.current.clearActiveProject(),
    setActiveProjectById: (id) =>
      projectOpsHandleRef.current.setActiveProjectById(id),
    defaultShareModeRef,
    shellDefaultCommandRef,
    shellDefaultArgsRef,
    shellInheritEnvRef,
    shellPromptBeforeCloseRef,
    prepareWorkspaceStartup,
    isShellBusy: async (tabId: string) => {
      const v = await invoke("shell_is_busy", { tabId });
      return v === true;
    },
  });

  useRestoreShellTabs({
    tabs: (state.tabs as Tab[] | undefined) ?? [],
    updateTab,
    appendSystem: (text) => chatActionsRef.current.appendSystem(text),
    shellInheritEnvRef,
  });

  // Tab/sub-tab navigation (next/jump/move for both agent tabs and
  // shell sub-tabs) lives in useTabNavigation. The hook computes the
  // target id and delegates to setActiveTab / setActiveSubTab.
  const {
    nextTab,
    jumpToTab,
    moveActiveTab,
    nextShellSubTab,
    jumpToShellSubTab,
    moveActiveShellSubTab,
  } = useTabNavigation({ stateRef, setState, setActiveTab, setActiveSubTab });

  // ---------------------------------------------------------------------
  // Extensions hydration: themes, sidebar entries, keybindings, event
  // routes, layouts, frontend modules, slash commands. Each `hydrate*`
  // is a wholesale replacement (every delta from the bridge replaces
  // the prior set). Plus layout activation, layout component summary,
  // and the lastExtensionStateKeysRef pruning ledger.
  // ---------------------------------------------------------------------
  const {
    layoutCatalogueRef,
    extensionEventRoutesRef,
    extensionEventRoutingModeRef,
    extensionKeybindingsRef,
    slashCommandsRef,
    lastExtensionStateKeysRef,
    hydrateThemes,
    hydrateExtensions,
    hydrateEventRoutes,
    hydrateKeybindings,
    hydrateExtensionLayouts,
    hydrateFrontendModules,
    hydrateSlashCommands,
    listThemes,
    activateLayoutById,
  } = useExtensionsHydration({
    setState,
    setLayout,
    stateRef,
    registry,
    appendSystem: (text) => chatActionsRef.current.appendSystem(text),
    layout,
  });

  // ---------------------------------------------------------------------
  // Project ops (project list management + per-project tab buckets).
  // Mounts below useTabs because openProject/setActiveProject call
  // switchProjectBucket → dispatchTerminalReplay (from useTabs).
  // ---------------------------------------------------------------------
  const {
    projectsLoadedRef,
    allDiscoveredSessionsRef,
    buildSidebarHistory,
    knownTabIds,
    scopedDiscoveredSessions,
    recentSessionItems,
    syncProjectsToState,
    syncRecentSessionsToState,
    openProjectFromPicker,
    openProjectByPath,
    setActiveProjectById,
    clearActiveProject,
    removeProjectById,
    setProjectExpanded,
    setProjectIconUrl,
    refreshProjectWorkspaces,
    activateWorkspace,
    createWorkspaceForProject,
    createWorkspaceWithParams,
    removeWorkspaceById,
    dismissPendingWorkspace,
    retryPendingWorkspace,
    renameWorkspace,
    renameProject,
    setProjectWorkspaceBaseBranch,
    reorderWorkspace,
    sortProjectWorkspacesNewest,
  } = useProjectOps({
    setState,
    stateRef,
    projectsRef,
    tabBucketsRef,
    piDefaultModelRef,
    gitStatusRef,
    refreshGitStatusFor,
    refreshAllGitStatus,
    announceProjectToBridge,
    watchProjectForBridge,
    unwatchProjectForBridge,
    dispatchTerminalReplay,
    autoRestoreDiscoveredSessions,
    closeTabNow,
    newShellTab,
    workspacePrompts,
  });
  useProjectSyncEffects({
    state,
    stateRef,
    projectsRef,
    setActiveProjectById,
    activateWorkspace,
    setProjectIconUrl,
  });

  // Orphan agent-worker cleanup (#159): retire per-tab workers whose tab is
  // gone from the live set, a faster complement to the Rust idle sweep. Needs
  // tabBucketsRef so the live set spans every project bucket, not just the
  // active one (tabs are project-scoped).
  useAgentWorkerReconcile(stateRef, tabBucketsRef);

  // Speak the agent's reply aloud on turn completion when enabled (LFM2-Audio
  // text-to-speech). Listens for the `aethon://agent-turn-complete` signal
  // emitted by the response_end handler.
  useSpeakReplies(stateRef);

  // Hydrate per-workspace tab buckets restored from disk into tabBucketsRef so
  // switching to a backgrounded workspace after a restart lands on its
  // last-active tab rather than the empty landing card.
  useTabBucketHydration(state.persistedTabBuckets, tabBucketsRef);

  const {
    updateTabRouted,
    findTabRouted,
    clearClosedIssueLinksForProject,
  } = useRoutedTabHelpers({ setState, stateRef, projectsRef, tabBucketsRef });

  // ---------------------------------------------------------------------
  // Toast stack + OS completion notification. Owned by useNotifications.
  // pushNotification's eviction path resolves any pending consent prompt
  // it silently drops, so the originator promise never dangles.
  // ---------------------------------------------------------------------
  const {
    pushNotification,
    dismissNotification,
    maybeFireCompletionNotification,
  } = useNotifications({
    setState,
    stateRef,
    notifyOnCompletionRef,
    notifyMinDurationMsRef,
    resolveShellWriteConsent,
    resolveShellCloseConsent,
    resolveWorkspacePrompt: workspacePrompts.resolveWorkspacePrompt,
  });

  // ---------------------------------------------------------------------
  // Focus + chrome toggles — terminal panel, composer/terminal focus
  // shuttle, sidebar toggle.
  // ---------------------------------------------------------------------
  const {
    toggleTerminal,
    toggleTerminalAndFocus,
    toggleFocusComposerTerminal,
    focusActiveContextInput,
    toggleSidebar,
    toggleFilesSidebar,
  } = useFocus({
    setState,
    stateRef,
    newShellTabOnOverviewOpen: () => newShellTab(),
  });

  const {
    openScheduledTasks,
    closeScheduledTasks,
    togglePlanMode,
    toggleAccounts,
  } = useRootChromeActions({
    setState,
    stateRef,
    updateActiveTab,
    pushNotification,
  });

  const { slashContext, persistLocalChatMessage } = useAppSlashCommandContext({
    bootLayout: BOOT_LAYOUT,
    setState,
    setLayout,
    stateRef,
    projectsRef,
    layoutCatalogueRef,
    registry,
    appendMessage: (msg, tabId) =>
      chatActionsRef.current.appendMessage(msg, tabId),
    pushNotification,
    clearChat: () => chatActionsRef.current.clearChat(),
    setTheme,
    listThemes,
    setModel: (id) => chatActionsRef.current.setModel(id),
    toggleTerminal,
    toggleSidebar,
    toggleFilesSidebar,
    activateLayoutById,
    openProjectFromPicker,
    openProjectByPath,
    setActiveProjectById,
    clearActiveProject,
    removeProjectById,
  });

  // ---------------------------------------------------------------------
  // Chat helpers (appendMessage, appendOrAmendAgentText, sendChat,
  // setModel, stopPrompt, clearChat, exportActiveChatMarkdown). Owns
  // activeResponseIdRef + turnStartedAtRef.
  // ---------------------------------------------------------------------
  const {
    activeResponseIdRef,
    turnStartedAtRef,
    appendMessage,
    appendOrAmendAgentText,
    appendSystem,
    setStatusFlags,
    clearChat,
    sendChat,
    setModel,
    setThinkingLevel,
    setCodexFastMode,
    stopPrompt,
    exportActiveChatMarkdown,
    editQueuedMessage,
    deleteQueuedMessage,
    steerQueuedMessage,
    clearQueuedMessages,
  } = useChat({
    setState,
    stateRef,
    updateTab: updateTabRouted,
    updateActiveTab,
    pendingTabOpens,
    slashCommandsRef,
    pushNotification,
    slashContext: () => slashContext(),
    persistLocalChatMessage,
    recordProjectModel,
    piDefaultModelRef,
    findTabById: findTabRouted,
  });

  useControlRequests({
    stateRef,
    pendingTabOpens,
    newTab,
    closeTabNow,
    setActiveTab,
    updateTab: updateTabRouted,
    sendChat,
    stopPrompt,
  });

  useScheduledTasks({
    state,
    setState,
    appendMessage,
    persistLocalChatMessage,
    pushNotification,
  });

  // All forward-ref slots — used by earlier hooks to call through to
  // functions that aren't defined until after them — are mirrored here
  // in a single commit-phase pass. See `useAppForwardRefs` for the
  // pattern + why no deps array.
  useAppForwardRefs({
    projectOpsHandleRef,
    projectsHandleRef,
    projectsRef,
    pushNotificationRef,
    chatActionsRef,
    clearActiveProject,
    setActiveProjectById,
    syncProjectsToState,
    pushNotification,
    appendMessage,
    appendSystem,
    clearChat,
    setModel,
  });

  // Drain the per-tab client-side message queues. The hook subscribes to
  // tabs and re-fires its drain check on every commit; gating happens
  // inside the hook against `waiting`, `queuedMessages.length`,
  // `queuedSteeringId`, and a private in-flight set.
  useQueuedDispatch({
    tabs: (state.tabs as Tab[] | undefined) ?? [],
    sendChat,
    updateTab: updateTabRouted,
  });

  // Dashboard task launch orchestrator. Shared by the per-project
  // dashboard composer event route AND the agent-side `startTask` pi tool.
  const startTaskInProject = useTaskLauncher({
    projectsRef,
    pushNotificationRef,
    setActiveProjectById,
    createWorkspaceWithParams,
    activateWorkspace,
    newTab,
    pendingTabOpens,
    sendChat,
    setState,
    stateRef,
    tabBucketsRef,
    piDefaultModelRef,
    prepareWorkspaceStartup,
  });

  const activateTabAnywhere = useActivateTabAnywhere({
    stateRef,
    tabBucketsRef,
    setActiveTab,
    setActiveProjectById,
    clearActiveProject,
    activateWorkspace,
  });

  // Updater (Cmd menu / tray "Check for Updates" + agent-driven path).
  // The hook reads the persisted channel + auto-check toggle from
  // `config.toml` during its own boot lifecycle, so we don't have to
  // race the boot-config ref read here. Settings save still routes
  // through `reapplyConfigWithUpdater` below so a runtime change
  // updates the hook immediately instead of waiting for the next
  // poll to pick up the new file.
  const {
    state: updaterState,
    actions: {
      checkForUpdates,
      installNow,
      dismiss,
      retryInstall,
      setChannel: setUpdateChannel,
      setDisableAutoCheck: setUpdateDisableAutoCheck,
    },
  } = useUpdater({ appendSystem });
  const reapplyConfigWithUpdater = useUpdaterConfigBridge({
    reapplyConfig,
    setUpdateChannel,
    setUpdateDisableAutoCheck,
  });

  // ---------------------------------------------------------------------
  // Settings panel + session search + command palette. Three modal
  // overlays mounted at App root. Settings save re-applies the new
  // config via reapplyConfig so the running app picks up theme / font /
  // ref-tracked defaults without a page reload.
  // ---------------------------------------------------------------------
  const {
    openSettings,
    toggleSettings,
    closeSettings,
    applySettingsPatch,
    saveSettings,
    toggleSessionSearch,
    closeSessionSearch,
    setSearchQuery,
    setSearchScope,
    openSearchHit,
    openPalette,
    closePalette,
    runPaletteItem,
  } = useUiOverlays({
    setState,
    stateRef,
    reapplyConfig: reapplyConfigWithUpdater,
    pushNotification,
    setActiveTab,
    newTab,
    newEditorTab,
    setActiveProjectById,
    openProjectFromPicker,
    closeTab,
    nextTab,
    toggleTerminalAndFocus,
    toggleFocusComposerTerminal,
    clearChat,
    stopPrompt,
    adjustZoom,
    resetZoom,
    setTheme,
    setModel,
    activateLayoutById,
    sendChat,
    slashCommandsRef,
    slashContext: () => slashContext(),
  });

  // Bridge IPC: spawns the agent on mount, runs the boot handshake
  // (start_agent → boot_layout → report), and routes every
  // `agent-response` event through the per-type handler registry under
  // src/hooks/bridgeMessageHandlers/.
  useAppBridgeMessages({
    bootLayout: BOOT_LAYOUT,
    onBootError: (err) => {
      setStartupChromeReady(true);
      appendMessage({
        id: crypto.randomUUID(),
        role: "agent",
        text: `Failed to start agent: ${err}`,
      });
      setStatusFlags({ status: "error" });
    },
    setState,
    setLayout,
    stateRef,
    registry,
    piDefaultModelRef,
    allDiscoveredSessionsRef,
    projectsRef,
    projectsLoadedRef,
    activeResponseIdRef,
    hangWarnTimersRef,
    hangWarnActiveRef,
    turnStartedAtRef,
    lastExtensionStateKeysRef,
    pendingTabOpens,
    nativeWindowsRef,
    updateTab: updateTabRouted,
    updateActiveTab,
    newTab,
    newEditorTab,
    prepareWorkspaceStartup,
    dispatchTerminalReplay,
    autoRestoreDiscoveredSessions,
    hydrateThemes,
    hydrateExtensions,
    hydrateSlashCommands,
    hydrateKeybindings,
    hydrateEventRoutes,
    hydrateExtensionLayouts,
    hydrateFrontendModules,
    announceProjectToBridge,
    appendMessage,
    persistLocalChatMessage,
    recordProjectModel,
    appendOrAmendAgentText,
    setStatusFlags,
    pushNotification,
    dismissNotification,
    maybeFireCompletionNotification,
    knownTabIds,
    scopedDiscoveredSessions,
    recentSessionItems,
    syncRecentSessionsToState,
    syncNativeWindowsToState,
    routeShellWrite,
    startTaskInProject,
    markStartupChromeReady: () => setStartupChromeReady(true),
  });

  // Keyboard shortcuts + A2UI event routing.
  const onEvent = useAppInteractions({
    stateRef,
    extensionKeybindingsRef,
    setState,
    extensionEventRoutesRef,
    extensionEventRoutingModeRef,
    allDiscoveredSessionsRef,
    hasPendingShellWriteConsent,
    resolveShellWriteConsent,
    hasPendingShellCloseConsent,
    resolveShellCloseConsent,
    hasPendingSessionDeleteConsent,
    resolveSessionDeleteConsent,
    promptDeleteSessionConfirmation,
    hasPendingWorkspacePrompt: workspacePrompts.hasPendingWorkspacePrompt,
    resolveWorkspacePrompt: workspacePrompts.resolveWorkspacePrompt,
    pushNotification,
    dismissNotification,
    sendChat,
    stopPrompt,
    updateTab: updateTabRouted,
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
    closeAllWorkspaceSessions: () =>
      closeAllWorkspaceSessions({
        setState,
        stateRef,
        projectsRef,
        tabBucketsRef,
        closeTab,
      }),
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
    setActiveHost: (id) => {
      hostInfo.setActiveHost(id);
      clearActiveProject();
    },
    syncRecentSessionsToState,
    setProjectExpanded,
    refreshProjectWorkspaces,
    activateWorkspace,
    createWorkspaceForProject,
    startTaskInProject,
    clearClosedIssueLinksForProject,
    removeWorkspaceById,
    dismissPendingWorkspace,
    retryPendingWorkspace,
    renameWorkspace,
    renameProject,
    setProjectWorkspaceBaseBranch,
    reorderWorkspace,
    sortProjectWorkspacesNewest,
    invoke,
    writeState,
    toggleTerminalAndFocus,
    toggleSidebar,
    toggleFilesSidebar,
    nextTab,
    nextShellSubTab,
    moveActiveTab,
    moveActiveShellSubTab,
    jumpToTab,
    jumpToShellSubTab,
    reopenLastClosedTab,
    toggleSessionSearch,
    openPalette,
    togglePlanMode,
    adjustZoom,
    resetZoom,
    toggleFocusComposerTerminal,
    toggleSettings,
    openScheduledTasks,
    closeScheduledTasks,
    focusActiveContextInput,
    exportActiveChatMarkdown,
    toggleAccounts,
  });

  // Runtime API, bridge mirror, editor-tab persistence, and OS-edge listeners.
  useAppRuntimeSurfaces({
    layout,
    bootLayout: BOOT_LAYOUT,
    setLayout,
    setState,
    stateRef,
    registry,
    layoutCatalogueRef,
    projectsRef,
    newTab,
    closeTab,
    setActiveTab,
    activateLayoutById,
    openProjectFromPicker,
    openProjectByPath,
    setActiveProjectById,
    clearActiveProject,
    removeProjectById,
    projectsLoadedRef,
    tabsSignal: state.tabs,
    activeTabId: state.activeTabId,
    state,
    activeResponseIdRef,
    hangWarnTimersRef,
    hangWarnActiveRef,
    hangWarnNotifId,
    autoRestartAgentRef,
    shellInheritEnvRef,
    updateTab,
    newShellTab,
    nextTab,
    appendMessage,
    persistLocalChatMessage,
    appendSystem,
    setStatusFlags,
    clearChat,
    stopPrompt,
    toggleTerminal,
    toggleFilesSidebar,
    togglePlanMode,
    openSettings,
    openScheduledTasks,
    pushNotification,
    dismissNotification,
    checkForUpdates,
  });

  const {
    renderState,
    notificationsOpen,
    paletteOpen,
    settingsOpen,
    searchOpen,
    authProfilesOpen,
    scheduledTasksOpen,
  } = useDerivedRenderState({ state, buildSidebarHistory, hostInfo });
  const chromeReady = bootConfigReady && startupChromeReady;

  return (
    <AppRoot
      registry={registry}
      layout={layout}
      renderState={renderState}
      setState={setState}
      onEvent={onEvent}
      activeTabId={state.activeTabId as string | undefined}
      notificationsOpen={notificationsOpen}
      paletteOpen={paletteOpen}
      settingsOpen={settingsOpen}
      searchOpen={searchOpen}
      authProfilesOpen={authProfilesOpen}
      scheduledTasksOpen={scheduledTasksOpen}
      chromeReady={chromeReady}
      startupLogoUrl={logoUrl}
      workspaceStartup={workspaceStartupView}
      onStartupApprove={approveStartup}
      onStartupRetry={retryStartup}
      onStartupContinue={continueStartup}
      topBanner={
        <UpdateBanner
          state={updaterState}
          onInstallNow={installNow}
          onDismiss={dismiss}
          onRetry={retryInstall}
        />
      }
    />
  );
}
