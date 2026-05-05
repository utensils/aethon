import { useEffect, useMemo, useRef, useState } from "react";
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
import { useTabs } from "./hooks/useTabs";
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
import { writeState } from "./persist";
import { createAppStore, useAppState } from "./state/appStore";
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
  const appStore = useMemo(() => createAppStore((() => {
    const tab0 = makeEmptyTab("default", "Tab 1");
    return {
      ...(BOOT_LAYOUT.state ?? {}),
      logoUrl,
      // App version surfaced as a state slice so layout JSON can $ref it
      // (e.g. sidebar's `version` prop). Single source of truth is
      // package.json — vite injects __APP_VERSION__ at build time. The
      // "v" prefix matches the human-friendly format the UI used before.
      appVersion: `v${__APP_VERSION__}`,
      tabs: [tab0],
      activeTabId: tab0.id,
      // Mirror keys point at the active tab's empty view so layout bindings
      // see well-defined values from boot.
      messages: tab0.messages,
      draft: tab0.draft,
      waiting: tab0.waiting,
      queueCount: tab0.queueCount,
      canvas: tab0.canvas,
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
    };
  })()), []);
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
  });
  // Wire the chat-actions handle in commit phase so useTabs /
  // useExtensionsHydration's appendSystem-via-stub becomes the live one
  // before any of their handlers fire.
  useEffect(() => {
    chatActionsRef.current = { appendSystem };
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
    pushNotification,
    dismissNotification,
    checkForUpdates,
  });

  // Build the dispatch context fresh per invocation so handlers see latest
  // state (model list, skills) without re-creating the command registry.
  function slashContext(): SlashCommandContext {
    return {
      appendSystem,
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
    // Derive /agentTabActive + /shellTabActive from the active tab's kind
    // so layout `visible: { $ref: "/agentTabActive" }` bindings can never
    // lag behind the tabs/activeTabId mutation that produced them.
    const { agentTabActive, shellTabActive } = deriveTabActiveFlags(
      tabs,
      state.activeTabId as string | undefined,
    );
    return {
      ...state,
      hasTabs,
      empty: !hasTabs,
      agentTabActive,
      shellTabActive,
      sidebar: {
        ...sidebar,
        history,
      },
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
