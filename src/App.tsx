import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExtensionRegistry } from "./extensions/ExtensionRegistry";
import { defaultLayoutExtension } from "./extensions/default-layout";
import { AppRoot } from "./app/AppRoot";
import { BOOT_LAYOUT, hangWarnNotifId } from "./app/bootConstants";
import { useAppForwardRefs } from "./app/useAppForwardRefs";
import type { A2UIPayload } from "./types/a2ui";
import type { Tab } from "./types/tab";
import { useZoomAndTheme } from "./hooks/useZoomAndTheme";
import { useShellConsent } from "./hooks/useShellConsent";
import { useHostInfo } from "./hooks/useHostInfo";
import { useDevshell, type DevshellEntry } from "./hooks/useDevshell";
import { activeCwd as projectsActiveCwd, type ProjectsState } from "./projects";
import { useProjects } from "./hooks/useProjects";
import { useAgentWorkerReconcile } from "./hooks/useAgentWorkerReconcile";
import { useAgentActivityHydration } from "./hooks/useAgentActivityHydration";
import { useVcsStatus } from "./hooks/useVcsStatus";
import { useGitWatch } from "./hooks/useGitWatch";
import { useTabNavigation } from "./hooks/useTabNavigation";
import { useTabs } from "./hooks/useTabs";
import { useRestoreShellTabs } from "./hooks/useRestoreShellTabs";
import { useExtensionsHydration } from "./hooks/useExtensionsHydration";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWindowApi } from "./runtime/windowApi";
import { useBootConfig } from "./hooks/useBootConfig";
import { useNotifications } from "./hooks/useNotifications";
import { useWorktreePrompts } from "./hooks/useWorktreePrompts";
import { useFocus } from "./hooks/useFocus";
import { useChat } from "./hooks/useChat";
import { useQueuedDispatch } from "./hooks/useQueuedDispatch";
import { useFrontendStateMirror } from "./hooks/useFrontendStateMirror";
import { usePersistEditorTabs } from "./hooks/usePersistEditorTabs";
import { useUiOverlays } from "./hooks/useUiOverlays";
import { useUpdater } from "./hooks/useUpdater";
import { UpdateBanner } from "./components/UpdateBanner";
import type { AethonConfig } from "./config";
import {
  useProjectOps,
  projectIdFromBucketKey,
  worktreeIdFromBucketKey,
} from "./hooks/useProjectOps";
import { useOsEdges } from "./hooks/useOsEdges";
import {
  buildInitialAppStore,
  useSessionPersistence,
} from "./hooks/useSessionPersistence";
import { useDerivedRenderState } from "./hooks/useDerivedRenderState";
import { useTabBucketHydration } from "./hooks/useTabBucketHydration";
import { useTaskLauncher } from "./hooks/useTaskLauncher";
import { useAppEventRouting } from "./hooks/useAppEventRouting";
import { useAppStateRefs } from "./hooks/useAppStateRefs";
import { useProjectModelRecorder } from "./hooks/useProjectModelRecorder";
import { useProjectSyncEffects } from "./hooks/useProjectSyncEffects";
import { useAppSlashCommandContext } from "./hooks/useAppSlashCommandContext";
import { useAppBridgeMessages } from "./hooks/useAppBridgeMessages";
import { writeState } from "./persist";
import { useAppState } from "./state/appStore";
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

  // Active layout payload — replaceable. Extensions can swap the chrome wholesale
  // by calling window.aethon.setLayout(payload), or register a new extension via
  // window.aethon.registerExtension(extension) and switch to its layout.
  const [layout, setLayout] = useState<A2UIPayload>(BOOT_LAYOUT);

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

  useSessionPersistence({ appStore, hasSyncSessionSnapshot });
  useAgentActivityHydration(setState);

  const recordProjectModel = useProjectModelRecorder(setState);

  // ---------------------------------------------------------------------
  // Boot config: read ~/.aethon/config.toml + persisted theme/zoom/sidebar
  // state from disk and seed live config refs. `reapplyConfig` is the
  // settings save path's re-prime helper.
  // ---------------------------------------------------------------------
  const {
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

  const worktreePrompts = useWorktreePrompts({
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

  // Devshell badge wiring. Track the current project root; the hook
  // hydrates the chip from the Rust cache on switch and stays in
  // sync via the Tauri `devshell-*` events. Events are also
  // forwarded into the agent so the bash-tool spawnHook's cache
  // stays warm without polling.
  const projectsSlice = state.projects as ProjectsState | undefined;
  const devshellActiveRoot = projectsSlice ? projectsActiveCwd(projectsSlice) : null;
  useDevshell({
    activeRoot: devshellActiveRoot,
    setDevshellEntry: (root, patch) => {
      setState((s) => {
        const prev = (s.devshell as { entries?: Record<string, DevshellEntry> }) ?? {};
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
  // active project/worktree root into the `/vcs` slice, consumed by the
  // header `vcs-status` cluster and the `source-control-panel` above the
  // file tree. Root derivation mirrors the file tree (file-tree.tsx): the
  // active worktree path when one is selected, else the active project's
  // path, else the active editor tab's root — so when an editor is open on
  // a git repo with no project selected, the VCS surface tracks the same
  // root the tree is decorating. The file tree's final `~/.aethon` fallback
  // is intentionally omitted: it is never a git repo, so `/vcs` would
  // collapse anyway, and replicating the async home-dir fetch here is noise.
  // (devshellActiveRoot reads a different state shape and can lag.)
  const vcsActiveRoot = (() => {
    const wtId = (state.activeWorktreeId as string | null) ?? null;
    if (wtId) {
      const projs =
        ((state.sidebar as { projects?: Array<{ worktrees?: Array<{ id: string; path?: string }> }> } | undefined)
          ?.projects) ?? [];
      for (const p of projs) {
        const wt = p.worktrees?.find((w) => w.id === wtId);
        if (wt?.path) return wt.path;
      }
    }
    const projectPath = (state.project as { path?: string } | null)?.path;
    if (projectPath) return projectPath;
    const tabs =
      (state.tabs as
        | Array<{ id: string; kind?: string; editor?: { rootPath?: string } }>
        | undefined) ?? [];
    const activeTabId = state.activeTabId as string | undefined;
    const activeTab = activeTabId
      ? tabs.find((t) => t.id === activeTabId)
      : undefined;
    if (activeTab?.kind === "editor" && activeTab.editor?.rootPath) {
      return activeTab.editor.rootPath;
    }
    return null;
  })();
  useVcsStatus({ activeRoot: vcsActiveRoot, setState });
  useGitWatch(vcsActiveRoot);

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
    piDefaultModelRef,
    clearActiveProject: () => projectOpsHandleRef.current.clearActiveProject(),
    setActiveProjectById: (id) =>
      projectOpsHandleRef.current.setActiveProjectById(id),
    defaultShareModeRef,
    shellDefaultCommandRef,
    shellDefaultArgsRef,
    shellInheritEnvRef,
    shellPromptBeforeCloseRef,
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
    tabBucketsRef,
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
    refreshProjectWorktrees,
    activateWorktree,
    createWorktreeForProject,
    createWorktreeWithParams,
    removeWorktreeById,
    dismissPendingWorktree,
    retryPendingWorktree,
    renameWorktree,
    renameProject,
    setProjectWorktreeBaseBranch,
  } = useProjectOps({
    setState,
    stateRef,
    projectsRef,
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
    worktreePrompts,
  });
  useProjectSyncEffects({
    state,
    stateRef,
    projectsRef,
    setActiveProjectById,
    activateWorktree,
    setProjectIconUrl,
  });

  // Orphan agent-worker cleanup (#159): retire per-tab workers whose tab is
  // gone from the live set, a faster complement to the Rust idle sweep. Needs
  // tabBucketsRef so the live set spans every project bucket, not just the
  // active one (tabs are project-scoped).
  useAgentWorkerReconcile(stateRef, tabBucketsRef);

  // Hydrate per-workspace tab buckets restored from disk into tabBucketsRef so
  // switching to a backgrounded workspace after a restart lands on its
  // last-active tab rather than the empty landing card.
  useTabBucketHydration(state.persistedTabBuckets, tabBucketsRef);

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
    resolveWorktreePrompt: worktreePrompts.resolveWorktreePrompt,
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
    stopPrompt,
    exportActiveChatMarkdown,
    editQueuedMessage,
    deleteQueuedMessage,
    steerQueuedMessage,
    clearQueuedMessages,
  } = useChat({
    setState,
    stateRef,
    updateTab,
    updateActiveTab,
    pendingTabOpens,
    slashCommandsRef,
    pushNotification,
    slashContext: () => slashContext(),
    persistLocalChatMessage,
    recordProjectModel,
    piDefaultModelRef,
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
    updateTab,
  });

  // Dashboard task launch orchestrator. Shared by the per-project
  // dashboard composer event route AND the agent-side `startTask` pi tool.
  const startTaskInProject = useTaskLauncher({
    projectsRef,
    pushNotificationRef,
    setActiveProjectById,
    createWorktreeWithParams,
    activateWorktree,
    newTab,
    pendingTabOpens,
    sendChat,
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
  const reapplyConfigWithUpdater = useMemo(
    () =>
      (fresh: AethonConfig) => {
        reapplyConfig(fresh);
        setUpdateChannel(fresh.updates.channel);
        setUpdateDisableAutoCheck(fresh.updates.disableAutoCheck);
      },
    [reapplyConfig, setUpdateChannel, setUpdateDisableAutoCheck],
  );

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
    updateTab,
    updateActiveTab,
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
    routeShellWrite,
    startTaskInProject,
  });

  // Global keyboard shortcuts. Lives in useKeyboardShortcuts which
  // binds a document-level keydown listener with useCapture so we run
  // before xterm sees the keystroke.
  useKeyboardShortcuts({
    stateRef,
    extensionKeybindingsRef,
    toggleTerminalAndFocus,
    toggleSidebar,
    toggleFilesSidebar,
    toggleEditorPreview,
    clearChat,
    stopPrompt,
    newTab,
    newShellTab,
    nextTab,
    nextShellSubTab,
    moveActiveTab,
    moveActiveShellSubTab,
    jumpToTab,
    jumpToShellSubTab,
    reopenLastClosedTab,
    closeTab,
    toggleSessionSearch,
    openPalette,
    closePalette,
    adjustZoom,
    resetZoom,
    toggleFocusComposerTerminal,
    toggleSettings,
    closeSettings,
    focusActiveContextInput,
    exportActiveChatMarkdown,
    pushNotification,
  });

  // window.aethon runtime API + dev-only __AETHON_* debug hooks.
  // Lives in src/runtime/windowApi.ts; mounts via useWindowApi.
  useWindowApi({
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
  });

  // Mirror an allowlisted set of frontend state slices back to the bridge
  // so extensions can introspect them. Debounced at 16 ms so a flurry of
  // state changes (typing into the composer) coalesces into a single
  // patch per slice.
  useFrontendStateMirror({ state });

  // Persist open editor tabs (debounced) so they restore on next launch.
  usePersistEditorTabs({
    stateRef,
    projectsRef,
    projectsLoadedRef,
    tabsSignal: state.tabs,
    activeTabId: state.activeTabId,
  });

  // OS-edge event listeners — PTY streams, agent supervisor signals,
  // native menu, drag-drop file paths, clipboard image paste. Bridge
  // response IPC stays in useBridgeMessages; this hook only owns
  // listeners that aren't routed through the bridge response stream.
  useOsEdges({
    bootLayout: BOOT_LAYOUT,
    setState,
    stateRef,
    activeResponseIdRef,
    hangWarnTimersRef,
    hangWarnActiveRef,
    hangWarnNotifId,
    autoRestartAgentRef,
    updateTab,
    newTab,
    newShellTab,
    closeTab,
    nextTab,
    appendMessage,
    persistLocalChatMessage,
    appendSystem,
    setStatusFlags,
    clearChat,
    stopPrompt,
    toggleTerminal,
    toggleFilesSidebar,
    openSettings,
    pushNotification,
    dismissNotification,
    checkForUpdates,
  });

  // Intercept events from layout-level components before they reach
  // the agent. The layout speaks A2UI, but a few interactions need to
  // drive native APIs (Tauri IPC for chat send, model picker) — the
  // dispatcher lives in `src/eventRoutes/` and is wired here. Three
  // precedence layers, in order: shell-consent reserved prefixes
  // (security boundary), extension event-routes (extensibility),
  // built-in route table.
  const onEvent = useAppEventRouting({
    setState,
    stateRef,
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
    hasPendingWorktreePrompt: worktreePrompts.hasPendingWorktreePrompt,
    resolveWorktreePrompt: worktreePrompts.resolveWorktreePrompt,
    pushNotification,
    dismissNotification,
    sendChat,
    stopPrompt,
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
    setActiveTab,
    activateTabAnywhere: (tabId: string) => {
      const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
      if (tabs.some((t) => t.id === tabId)) {
        setActiveTab(tabId);
        return;
      }
      // Not in the active workspace — find the bucket that owns it, switch
      // into that project/worktree, then select. setState is synchronous so
      // the bucket load lands before setActiveTab reads state.tabs.
      for (const [key, bucket] of tabBucketsRef.current.entries()) {
        if (!bucket.tabs.some((t) => t.id === tabId)) continue;
        const projectId = projectIdFromBucketKey(key);
        const currentProjectId =
          (stateRef.current.activeProjectId as string | null | undefined) ??
          null;
        if (projectId !== currentProjectId) {
          if (projectId) setActiveProjectById(projectId);
          else clearActiveProject();
        }
        activateWorktree(worktreeIdFromBucketKey(key));
        setActiveTab(tabId);
        return;
      }
      // Unknown tab — best effort (no-op if it's truly gone).
      setActiveTab(tabId);
    },
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
    setTheme,
    activateLayoutById,
    openProjectFromPicker,
    setActiveProjectById,
    removeProjectById,
    setActiveHost: (id) => {
      hostInfo.setActiveHost(id);
      clearActiveProject();
    },
    syncRecentSessionsToState,
    setProjectExpanded,
    refreshProjectWorktrees,
    activateWorktree,
    createWorktreeForProject,
    startTaskInProject,
    removeWorktreeById,
    dismissPendingWorktree,
    retryPendingWorktree,
    renameWorktree,
    renameProject,
    setProjectWorktreeBaseBranch,
    invoke,
    writeState,
  });

  const {
    renderState,
    notificationsOpen,
    paletteOpen,
    settingsOpen,
    searchOpen,
    authProfilesOpen,
  } = useDerivedRenderState({ state, buildSidebarHistory, hostInfo });

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
