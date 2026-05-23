import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import A2UIRenderer, { RegistryComponent } from "./components/A2UIRenderer";
import { SkillRegistry } from "./skills/SkillRegistry";
import { SkillRegistryProvider } from "./skills/registry";
import { defaultLayoutSkill } from "./skills/default-layout";
import type { A2UIPayload } from "./types/a2ui";
import { deriveTabActiveFlags, makeEmptyTab, type Tab } from "./types/tab";
import { dispatchEvent, type EventRouteContext } from "./eventRoutes";
import { useZoomAndTheme } from "./hooks/useZoomAndTheme";
import { useShellConsent } from "./hooks/useShellConsent";
import { useProjects } from "./hooks/useProjects";
import { useTabNavigation } from "./hooks/useTabNavigation";
import { TAB_MIRROR_KEYS, useTabs } from "./hooks/useTabs";
import { useExtensionsHydration } from "./hooks/useExtensionsHydration";
import { useBridgeMessages } from "./hooks/useBridgeMessages";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWindowApi } from "./runtime/windowApi";
import { useBootConfig } from "./hooks/useBootConfig";
import { useNotifications } from "./hooks/useNotifications";
import { useFocus } from "./hooks/useFocus";
import { useChat } from "./hooks/useChat";
import { useFrontendStateMirror } from "./hooks/useFrontendStateMirror";
import { useUiOverlays } from "./hooks/useUiOverlays";
import { useUpdater } from "./hooks/useUpdater";
import { useProjectOps } from "./hooks/useProjectOps";
import { useOsEdges } from "./hooks/useOsEdges";
import type { SlashCommandContext } from "./slashCommands";
import { readState, writeState } from "./persist";
import { createAppStore, useAppState } from "./state/appStore";
import {
  SESSION_UI_SNAPSHOT_FILE,
  loadSessionUiSnapshot,
  parseSessionUiSnapshot,
  saveSessionUiSnapshot,
  type SessionUiSnapshot,
} from "./state/sessionUiSnapshot";
import {
  activeProject,
  emptyProjectsState,
  type ProjectsState,
} from "./projects";
// Vite resolves `?url` imports to a hashed asset URL at build time. Injecting
// the URL into layout state lets the header bind via `{"$ref": "/logoUrl"}`
// instead of hardcoding a path that might 404 in a production bundle.
import logoUrl from "./assets/aethon-logo.svg?url";

// The default-layout skill ships a layout — that's the boot payload.
const BOOT_LAYOUT: A2UIPayload = defaultLayoutSkill.layout!;

interface RecentSessionItem {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

export default function App() {
  // The registry is created once and shared across the app via context.
  // Skills register their components/layouts here; the renderer resolves
  // unknown component types through it.
  const [registry] = useState<SkillRegistry>(() => {
    const r = new SkillRegistry();
    r.register(defaultLayoutSkill);
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
  // Initial state also seeds one default tab + the active-tab mirror keys.
  const initialApp = useMemo(() => {
    const tab0 = makeEmptyTab("default", "Tab 1");
    const restored = loadSessionUiSnapshot();
    const tabs = restored?.tabs.length ? restored.tabs : [tab0];
    const activeTabId =
      restored?.activeTabId && tabs.some((t) => t.id === restored.activeTabId)
        ? restored.activeTabId
        : tabs[0].id;
    const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
    const restoredLayout =
      restored?.layout && typeof restored.layout === "object"
        ? (restored.layout as Record<string, unknown>)
        : {};
    const activeRecord = activeTab as unknown as Record<string, unknown>;
    const rootMirror = Object.fromEntries(
      TAB_MIRROR_KEYS.map((key) => [key, activeRecord[key]]),
    );
    return {
      appStore: createAppStore({
      ...(BOOT_LAYOUT.state ?? {}),
      ...(restored?.terminal ? { terminal: restored.terminal } : {}),
      ...(restored?.terminalPanel ? { terminalPanel: restored.terminalPanel } : {}),
      ...(restored?.scrollToMatchByTab
        ? { scrollToMatchByTab: restored.scrollToMatchByTab }
        : {}),
      ...(restored?.projectModels ? { projectModels: restored.projectModels } : {}),
      logoUrl,
      // App version surfaced as a state slice so layout JSON can $ref it
      // (e.g. sidebar's `version` prop). Single source of truth is
      // package.json — vite injects __APP_VERSION__ at build time. The
      // "v" prefix matches the human-friendly format the UI used before.
      appVersion: `v${__APP_VERSION__}`,
      tabs,
      activeTabId,
      // Mirror keys point at the active tab's empty view so layout bindings
      // see well-defined values from boot.
      ...rootMirror,
      // Layout-agnostic UI surfaces — the palette + notification stack
      // both render at App root so they overlay every layout. State
      // shapes are documented on the components themselves.
      palette: { open: false, mode: "switcher", query: "", selectedIndex: 0 },
      notifications: [],
      // Seed /sidebar/extensions so the $ref-bound sidebar section renders
      // the built-in entry immediately — hydrateExtensions() fills in
      // dynamically-loaded extensions once `ready` arrives.
      sidebar: {
        ...(BOOT_LAYOUT.state?.sidebar as Record<string, unknown> | undefined),
        extensions: [
          { id: "extension-layout", label: "default-layout", hint: "core", active: true },
        ],
      },
      ...(Object.keys(restoredLayout).length > 0
        ? {
            layout: {
              ...(BOOT_LAYOUT.state?.layout ?? {}),
              ...restoredLayout,
            },
          }
        : {}),
      }),
      hasSyncSessionSnapshot: Boolean(restored),
    };
  }, []);
  const { appStore, hasSyncSessionSnapshot } = initialApp;
  const state = useAppState(appStore, (s) => s);
  const setState = appStore.setState;

  // Active layout payload — replaceable. Skills can swap the chrome wholesale
  // by calling window.aethon.setLayout(payload), or register a new skill via
  // window.aethon.registerSkill(skill) and switch to its layout.
  const [layout, setLayout] = useState<A2UIPayload>(BOOT_LAYOUT);

  // Latest state, kept in a ref so the aethon-debug skill can read it via
  // `window.__AETHON_STATE__()` without going through React's state
  // lifecycle. Synced in commit phase — handlers see the latest state
  // because they only dereference after the next render commits.
  const stateRef = useRef(appStore.getState());
  useEffect(() => {
    stateRef.current = appStore.getState();
    return appStore.subscribe(() => {
      stateRef.current = appStore.getState();
    });
  }, [appStore]);

  function recordProjectModel(model: string, tabId?: string) {
    if (!model.trim()) return;
    setState((prev) => {
      const tabs = (prev.tabs as Tab[] | undefined) ?? [];
      const targetId =
        tabId ?? (prev.activeTabId as string | undefined) ?? undefined;
      const tab = targetId ? tabs.find((t) => t.id === targetId) : undefined;
      const projectId = tab?.projectId ?? null;
      if (!projectId) return prev;
      const projectModels =
        (prev.projectModels as Record<string, string> | undefined) ?? {};
      if (projectModels[projectId] === model) return prev;
      return {
        ...prev,
        projectModels: { ...projectModels, [projectId]: model },
      };
    });
  }

  const restoreSessionUiSnapshot = useCallback((snapshot: SessionUiSnapshot) => {
    setState((prev) => {
      const tabs = snapshot.tabs.length ? snapshot.tabs : [];
      if (tabs.length === 0) return prev;
      const activeTabId =
        snapshot.activeTabId && tabs.some((t) => t.id === snapshot.activeTabId)
          ? snapshot.activeTabId
          : tabs[0].id;
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
          ? { layout: { ...currentLayout, ...restoredLayout } }
          : {}),
        tabs,
        activeTabId,
        empty: false,
        hasTabs: true,
        ...rootMirror,
      };
    });
  }, [setState]);

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
    hot?.dispose(persistNow);
    if (hasSyncSessionSnapshot) {
      startPersistence();
    } else {
      readState(SESSION_UI_SNAPSHOT_FILE)
        .then((raw) => {
          if (cancelled) return;
          const snapshot = parseSessionUiSnapshot(raw);
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
    };
  }, [appStore, hasSyncSessionSnapshot, restoreSessionUiSnapshot]);

  // ---------------------------------------------------------------------
  // App-owned shared refs — owned here (rather than inside their primary
  // hook) so multiple hooks can read/write the same object without
  // construction-order dependencies. Each gets a one-line ownership note.
  // ---------------------------------------------------------------------
  // Project list — useTabs reads it for new-tab cwd inheritance,
  // useProjectOps mutates it. Shared via the same MutableRefObject.
  const projectsRef = useRef<ProjectsState>(emptyProjectsState());
  // Pi default model from `ready` — useTabs reads it for new-tab model
  // inheritance, the bridge `ready` handler writes it.
  const piDefaultModelRef = useRef<string>("");
  // Hang-warn timers/active set — useBridgeMessages owns scheduling,
  // useOsEdges clears them on supervisor signals.
  const hangWarnNotifId = (tabId: string) => `ae-hang-warn:${tabId}`;
  const hangWarnActiveRef = useRef<Set<string>>(new Set());
  const hangWarnTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const sessionSnapshotPersistTimerRef = useRef<number | null>(null);

  // Forward handles populated below as hooks construct. Lets earlier
  // hooks (useTabs / useProjects / useZoomAndTheme / useShellConsent)
  // call into later hooks (useProjectOps / useNotifications / useChat)
  // once they exist. Each handle is a no-op until wired.
  const projectOpsHandleRef = useRef({
    clearActiveProject: () => {},
    setActiveProjectById: (_id: string): boolean => false,
  });
  const projectsHandleRef = useRef({
    getPaths: (): string[] => [],
    onGitStatusChanged: () => {},
  });
  const pushNotificationRef = useRef<
    (n: Parameters<EventRouteContext["pushNotification"]>[0]) => void
  >(() => {});
  const chatActionsRef = useRef({
    appendSystem: (_text: string) => {},
  });

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
    shortcutsNewTabKindRef,
    reapplyConfig,
  } = useBootConfig({ setState });

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
    refreshProjectWorktrees,
    activateWorktree,
    createWorktreeForProject,
    createWorktreeWithParams,
    removeWorktreeById,
    dismissPendingWorktree,
    retryPendingWorktree,
    renameWorktree,
    renameProject,
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
  });
  // Wire forward handles now that the live functions exist. Ref writes
  // happen in commit phase (useEffect) — React disallows ref mutation
  // during render. Earlier hooks call through these stubs in their own
  // handlers/effects, which always run after commit, so the wiring is
  // ready by the time anything dereferences these.
  useEffect(() => {
    projectOpsHandleRef.current = { clearActiveProject, setActiveProjectById };
    projectsHandleRef.current = {
      getPaths: () => projectsRef.current.projects.map((p) => p.path),
      onGitStatusChanged: () => syncProjectsToState(),
    };
  });

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
  });
  // Thread the live pushNotification into the deferred ref so
  // useZoomAndTheme + useShellConsent + useTabs stop using the no-op
  // stub. Wired in commit phase — earlier hooks only dereference inside
  // their own handlers, which run after the first commit.
  useEffect(() => {
    pushNotificationRef.current = pushNotification;
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
  });
  // Wire the chat-actions handle in commit phase so useTabs /
  // useExtensionsHydration's appendSystem-via-stub becomes the live one
  // before any of their handlers fire.
  useEffect(() => {
    chatActionsRef.current = { appendSystem };
  });

  // ---------------------------------------------------------------------
  // Dashboard task launch orchestrator. Shared by the per-project
  // dashboard composer event route AND the agent-side `startTask` pi
  // tool, so both surfaces drive the same worktree-create + new-tab +
  // first-message chain.
  // ---------------------------------------------------------------------
  const startTaskInProject = useCallback(
    async (opts: {
      projectId: string;
      prompt: string;
      newWorktree?: boolean;
      branch?: string;
      baseBranch?: string;
    }): Promise<void> => {
      const project = projectsRef.current.projects.find(
        (p) => p.id === opts.projectId,
      );
      if (!project) return;
      let cwd = project.path;
      if (opts.newWorktree) {
        if (!opts.branch) return;
        const created = await createWorktreeWithParams({
          projectId: opts.projectId,
          branch: opts.branch,
          baseBranch: opts.baseBranch,
        });
        if (!created) return;
        cwd = created;
      }
      // Ensure the project we're launching into is the active one so the
      // new tab lands in the right per-project bucket.
      if (projectsRef.current.activeId !== opts.projectId) {
        setActiveProjectById(opts.projectId);
      }
      const tabId = crypto.randomUUID();
      newTab(tabId, undefined, { cwd });
      const opening = pendingTabOpens.current.get(tabId);
      if (opening) {
        try {
          await opening;
        } catch {
          /* tab open failed; sendChat below will no-op */
        }
      }
      const trimmed = opts.prompt.trim();
      if (trimmed) await sendChat(trimmed);
    },
    [
      createWorktreeWithParams,
      newTab,
      pendingTabOpens,
      projectsRef,
      sendChat,
      setActiveProjectById,
    ],
  );

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
  } = useFocus({ setState, stateRef });

  // Updater (Cmd menu / tray "Check for Updates" + agent-driven path).
  const { checkForUpdates } = useUpdater({ appendSystem });

  // ---------------------------------------------------------------------
  // Settings panel + session search + command palette. Three modal
  // overlays mounted at App root. Settings save re-applies the new
  // config via reapplyConfig so the running app picks up theme / font /
  // ref-tracked defaults without a page reload.
  // ---------------------------------------------------------------------
  const {
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
    reapplyConfig,
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
  useBridgeMessages({
    bootLayout: BOOT_LAYOUT,
    onBootError: (err) => {
      appendMessage({
        id: crypto.randomUUID(),
        role: "agent",
        text: `Failed to start agent: ${err}`,
      });
      setStatusFlags({ status: "error" });
    },
    ctx: {
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
    },
  });

  // Global keyboard shortcuts. Lives in useKeyboardShortcuts which
  // binds a document-level keydown listener with useCapture so we run
  // before xterm sees the keystroke.
  useKeyboardShortcuts({
    stateRef,
    extensionKeybindingsRef,
    shortcutsNewTabKindRef,
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
    appendSystem,
    setStatusFlags,
    clearChat,
    stopPrompt,
    toggleTerminal,
    toggleFilesSidebar,
    pushNotification,
    dismissNotification,
    checkForUpdates,
  });

  // Build the dispatch context fresh per invocation so handlers see latest
  // state (model list, skills) without re-creating the command registry.
  function persistLocalChatMessage(
    msg: { id: string; role: "user" | "agent" | "system"; text?: string },
    tabId: string,
  ) {
    if (!msg.text) return;
    invoke("agent_command", {
      payload: JSON.stringify({
        type: "local_chat_message",
        tabId,
        payload: {
          id: msg.id,
          role: msg.role,
          text: msg.text,
          createdAt: Date.now(),
        },
      }),
    }).catch(() => {
      /* bridge gone — visible state remains in-memory until reload */
    });
  }

  function slashContext(): SlashCommandContext {
    return {
      appendSystem: (text: string) => {
        const tabId =
          (stateRef.current.activeTabId as string | undefined) ?? "default";
        const msg = { id: crypto.randomUUID(), role: "system" as const, text };
        appendMessage(msg, tabId);
        persistLocalChatMessage(msg, tabId);
      },
      notify: (input) => {
        pushNotification(input);
      },
      clearChat,
      setTheme,
      listThemes,
      setModel,
      resetLayout: () => setLayout(BOOT_LAYOUT),
      listExtensions: () => registry.list().map((s) => s.name),
      installExtension: async (spec: string) => {
        return await invoke<string>("install_aethon_extension", { spec });
      },
      listModels: () => {
        const sidebar = (stateRef.current.sidebar as Record<string, unknown>) ?? {};
        return ((sidebar.models as { id: string; label: string; active?: boolean }[]) ?? []);
      },
      toggleTerminal,
      toggleSidebar,
      toggleFilesSidebar,
      activateLayout: activateLayoutById,
      listLayouts: () =>
        layoutCatalogueRef.current.map((l) => ({
          id: l.id,
          name: l.name,
          description: l.description,
        })),
      pickProject: openProjectFromPicker,
      openProject: (path: string, label?: string) => openProjectByPath(path, label),
      setActiveProject: setActiveProjectById,
      clearProject: clearActiveProject,
      removeProject: removeProjectById,
      listProjects: () =>
        projectsRef.current.projects.map((p) => ({
          id: p.id,
          label: p.label,
          path: p.path,
        })),
      reloadAgent: async () => {
        await invoke("reload_agent");
      },
      runNativeCommand: async (name: string, args: string) => {
        const activeId = stateRef.current.activeTabId;
        const tabId =
          typeof activeId === "string" && activeId.length > 0
            ? activeId
            : "default";
        await invoke("agent_command", {
          payload: JSON.stringify({
            type: "native_slash_command",
            tabId,
            name,
            args,
          }),
        });
      },
      renameSession: async (tabId: string, label: string) => {
        // Optimistic in-memory update so the open-tab row in the sidebar
        // history (and the top tab strip + palette) reflect the new
        // label immediately. The bridge persists label.txt; on the next
        // ready re-emit the closed-session bucket also picks it up.
        setState((prev) => {
          const tabs = (prev.tabs as Tab[] | undefined) ?? [];
          const idx = tabs.findIndex((t) => t.id === tabId);
          if (idx < 0) return prev;
          const trimmed = label.trim();
          const fallback = `Tab ${idx + 1}`;
          const nextLabel = trimmed.length > 0 ? trimmed : fallback;
          if (tabs[idx].label === nextLabel) return prev;
          const next = [...tabs];
          next[idx] = { ...next[idx], label: nextLabel };
          return { ...prev, tabs: next };
        });
        await invoke("agent_command", {
          payload: JSON.stringify({
            type: "set_session_label",
            tabId,
            label,
          }),
        });
      },
      activeTabId: () => {
        const id = stateRef.current.activeTabId;
        return typeof id === "string" && id.length > 0 ? id : null;
      },
      activeProject: () => {
        const a = activeProject(projectsRef.current);
        return a ? { id: a.id, label: a.label, path: a.path } : null;
      },
    };
  }

  // Intercept events from layout-level components before they reach
  // the agent. The layout speaks A2UI, but a few interactions need to
  // drive native APIs (Tauri IPC for chat send, model picker) — the
  // dispatcher lives in `src/eventRoutes/` and is wired here. Three
  // precedence layers, in order: shell-consent reserved prefixes
  // (security boundary), extension event-routes (extensibility),
  // built-in route table.
  const eventRouteCtx = useMemo<EventRouteContext>(
    () => ({
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
      pushNotification,
      dismissNotification,
      sendChat,
      stopPrompt,
      updateActiveTab,
      newTab,
      newShellTab,
      newEditorTab,
      updateEditorMeta,
      renameEditorTabsForPath,
    closeEditorTabsForPath,
      closeTab,
      setActiveTab,
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
      invoke,
      writeState,
    }),
    // Built once and reused across renders. Every closure inside
    // (sendChat, newTab, …) reads live state via stateRef / setState
    // callbacks; adding them as deps would force the memo to re-build
    // every render — losing any consumer-side memoization keyed on its
    // identity — without changing observed behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onEvent = useMemo(
    () =>
      (
        component: { id: string; type?: string },
        eventType: string,
        data?: unknown,
      ) => dispatchEvent({ component, eventType, data }, eventRouteCtx),
    [eventRouteCtx],
  );

  const renderState = useMemo(() => {
    const tabs = (state.tabs as Tab[] | undefined) ?? [];
    const recentSessions =
      (state.recentSessions as RecentSessionItem[] | undefined) ?? [];
    const sidebar = (state.sidebar as Record<string, unknown> | undefined) ?? {};
    const history = buildSidebarHistory(
      tabs,
      state.activeTabId as string | undefined,
      recentSessions,
    );
    // Derive the layout's tab-visibility gates from tabs.length so they
    // can never drift out of sync with reality. Code paths that mutate
    // tabs (newTab/closeTab/switchProjectBucket) still write hasTabs/empty
    // for cleanliness, but if any of them ever forget — or set both true
    // (the orphan-active-id case in switchProjectBucket fallthrough) —
    // the visible UI stays consistent.
    const hasTabs = tabs.length > 0;
    // Derive /agentTabActive + /shellTabActive + /editorTabActive from the
    // active tab's kind so layout `visible: { $ref: "/agentTabActive" }`
    // bindings can never lag behind the tabs/activeTabId mutation that
    // produced them.
    const { agentTabActive, shellTabActive, editorTabActive } =
      deriveTabActiveFlags(tabs, state.activeTabId as string | undefined);
    // Worktree landing — when /landing.kind === "worktree" the
    // landing page takes over the canvas slot. Suppress every other
    // canvas's visibility flag so only one component draws into the
    // canvas grid cell at a time.
    const landing = state.landing as { kind?: string } | null | undefined;
    const landingVisible = !!landing && landing.kind === "worktree";
    const empty = !hasTabs && !landingVisible;
    // Empty-state branching: when /empty is true we render either the
    // global projects-dashboard (no project active) or the per-project
    // dashboard (project active). Both target the canvas slot via the
    // empty-state slotMap; only one is visible at a time.
    const hasActiveProject =
      typeof state.project === "object" && state.project !== null;
    const emptyAndProject = empty && hasActiveProject;
    const emptyAndNoProject = empty && !hasActiveProject;
    // Per-project dashboard inputs derived from existing state. The
    // composites also tolerate missing/empty arrays so this stays
    // forward-compatible with extensions injecting more data.
    const activeProjectId =
      (state.project as { id?: string } | null | undefined)?.id ?? null;
    const sidebarProjects =
      ((state.sidebar as { projects?: unknown } | undefined)
        ?.projects as
        | { id: string; worktrees?: unknown }[]
        | undefined) ?? [];
    const activeProjectSidebarEntry = sidebarProjects.find(
      (p) => p.id === activeProjectId,
    );
    const projectDashboardWorktrees =
      (activeProjectSidebarEntry?.worktrees as unknown[] | undefined) ?? [];
    const recentSessionsArr = Array.isArray(state.recentSessions)
      ? (state.recentSessions as { cwd?: string }[])
      : [];
    const projectPath =
      (state.project as { path?: string } | null | undefined)?.path ?? null;
    const projectDashboardSessions = projectPath
      ? recentSessionsArr.filter((s) => {
          const sCwd = (s.cwd ?? "").replace(/[/\\]+$/, "");
          const pCwd = projectPath.replace(/[/\\]+$/, "");
          return sCwd === pCwd;
        })
      : [];
    const projectsArr = Array.isArray(state.projects)
      ? (state.projects as { id: string }[])
      : [];
    const otherProjects = activeProjectId
      ? projectsArr.filter((p) => p.id !== activeProjectId)
      : projectsArr;
    const existingProjectDashboard =
      (state.projectDashboard as
        | { widgets?: unknown[] }
        | undefined) ?? {};
    const projectDashboard = {
      ...existingProjectDashboard,
      otherProjects,
      worktrees: projectDashboardWorktrees,
      recentSessions: projectDashboardSessions,
      widgets: existingProjectDashboard.widgets ?? [],
    };
    const existingProjectsDashboard =
      (state.projectsDashboard as
        | { extraCards?: unknown[] }
        | undefined) ?? {};
    const projectsDashboard = {
      ...existingProjectsDashboard,
      extraCards: existingProjectsDashboard.extraCards ?? [],
    };
    return {
      ...state,
      hasTabs,
      empty,
      emptyAndProject,
      emptyAndNoProject,
      agentTabActive: agentTabActive && !landingVisible,
      shellTabActive: shellTabActive && !landingVisible,
      editorTabActive: editorTabActive && !landingVisible,
      landingVisible,
      sidebar: {
        ...sidebar,
        history,
      },
      projectDashboard,
      projectsDashboard,
    };
  }, [buildSidebarHistory, state]);
  const renderRecord = renderState as Record<string, unknown>;
  const notificationsOpen =
    ((renderRecord.notifications as unknown[] | undefined) ?? []).length > 0;
  const paletteOpen = Boolean(
    (renderRecord.palette as { open?: boolean } | undefined)?.open,
  );
  const settingsOpen = Boolean(
    (renderRecord.settings as { open?: boolean } | undefined)?.open,
  );
  const searchOpen = Boolean(
    (renderRecord.search as { open?: boolean } | undefined)?.open,
  );

  return (
    <SkillRegistryProvider registry={registry}>
      <div className="app">
        <A2UIRenderer
          payload={layout}
          state={renderState}
          onStateChange={setState}
          onEvent={onEvent}
          tabId={state.activeTabId as string | undefined}
        />
        {/* App-root overlays — registry-resolved so a skill can replace any
            of them via aethon.registerComponent("<type>", custom). Each
            overlay gates its own visibility on state (e.g. /commandPalette
            /open), so the renderers stay mounted but render null when
            closed. tabId is forwarded so extension override templates
            route their bridge events against the active pi session. */}
        {notificationsOpen && (
          <RegistryComponent
            type="notification-stack"
            state={renderState}
            onEvent={onEvent}
            tabId={state.activeTabId as string | undefined}
          />
        )}
        {paletteOpen && (
          <RegistryComponent
            type="command-palette"
            state={renderState}
            onEvent={onEvent}
            tabId={state.activeTabId as string | undefined}
          />
        )}
        {settingsOpen && (
          <RegistryComponent
            type="settings-panel"
            state={renderState}
            onEvent={onEvent}
            tabId={state.activeTabId as string | undefined}
          />
        )}
        {searchOpen && (
          <RegistryComponent
            type="search-panel"
            state={renderState}
            onEvent={onEvent}
            tabId={state.activeTabId as string | undefined}
          />
        )}
      </div>
    </SkillRegistryProvider>
  );
}
