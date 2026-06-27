import { useRef } from "react";
import type { ClosedTabEntry } from "../types/tab";
import { useMutations, dispatchTerminalReplay } from "./tabOps/mutations";
import { useNewTab } from "./tabOps/agentTab";
import { useNewShellTab } from "./tabOps/shellTab";
import { useEditorTabActions } from "./tabOps/editorTab";
import { useCloseTabActions } from "./tabOps/closeTab";
import { useAutoRestoreDiscoveredSessions } from "./tabOps/autoRestore";
import type { UseTabsActions, UseTabsContext } from "./tabOps/types";

export { TAB_MIRROR_KEYS, TERMINAL_REPLAY_MAX } from "./tabOps/constants";
export {
  cwdForNewTab,
  modelForNewProjectTab,
  recentSessionItemFromClosedTab,
} from "./tabOps/helpers";
export type { UseTabsActions, UseTabsContext } from "./tabOps/types";

/**
 * Tab lifecycle: create (newTab/newShellTab/newEditorTab), switch
 * (setActiveTab/setActiveSubTab), update (updateTab/updateActiveTab),
 * close (closeTab/closeTabNow), and undo-close
 * (pushClosedTab/reopenLastClosedTab).
 *
 * This file is the facade. The actual implementation lives under
 * `./tabOps/`:
 *
 * - `constants` — TAB_MIRROR_KEYS, TERMINAL_REPLAY_MAX, plus private caps
 * - `types`     — UseTabsContext, UseTabsActions, DiscoveredSession,
 *                 NotificationInput
 * - `helpers`   — pure data helpers (session labels, model/cwd resolution,
 *                 recentSessions projection, editorLabelForPath)
 * - `mutations` — `updateTab` / `updateActiveTab` (mirror-write the active
 *                 tab's TAB_MIRROR_KEYS into the root state) and the
 *                 active-tab + sub-tab switchers
 * - `agentTab`  — `newTab` (the agent-tab creator with bridge `tab_open`)
 * - `shellTab`  — `newShellTab` (panel-only, seeds share mode atomically)
 * - `editorTab` — `newEditorTab`, edits, and rename reconciliation
 * - `closeTab`  — close + reopen, bridge `tab_close`, Monaco buffer
 *                 disposal, and the path-based bulk close
 *                 (`closeEditorTabsForPath`) routed through `closeTab`
 *                 to honor the dirty-buffer confirm prompt
 * - `autoRestore` — boot-time discovered-session restore (≤ 8, oldest
 *                   first so the newest lands active)
 *
 * The hook keeps its state local in refs; project bucket swap and
 * orchestration-level wiring (chat-input dispatch, sidebar history,
 * keyboard shortcuts) stays in App.tsx and reaches in via ctx
 * callbacks. Shell config refs are passed in (rather than owned)
 * because the boot config effect and the settings panel apply path
 * also write to them.
 *
 * /agentTabActive + /shellTabActive are derived in App's renderState
 * from tabs/activeTabId — not mirrored here — so they can't lag the
 * tabs mutation that produced them.
 */
export function useTabs(ctx: UseTabsContext): UseTabsActions {
  const pendingTabOpens = useRef(new Map<string, Promise<unknown>>());
  const closedTabsRef = useRef<ClosedTabEntry[]>([]);
  const autoRestoredSessionIdsRef = useRef(new Set<string>());

  // Mirror writes + active-tab switching come first; they have no
  // dependencies beyond setState/stateRef and everything else calls
  // back into them.
  const mutations = useMutations({
    setState: ctx.setState,
    stateRef: ctx.stateRef,
  });

  const newTab = useNewTab({
    setState: ctx.setState,
    stateRef: ctx.stateRef,
    projectsRef: ctx.projectsRef,
    piDefaultModelRef: ctx.piDefaultModelRef,
    pendingTabOpens,
    appendSystem: ctx.appendSystem,
    dispatchTerminalReplay,
    prepareWorkspaceStartup: ctx.prepareWorkspaceStartup,
  });

  const newShellTab = useNewShellTab({
    setState: ctx.setState,
    stateRef: ctx.stateRef,
    projectsRef: ctx.projectsRef,
    appendSystem: ctx.appendSystem,
    defaultShareModeRef: ctx.defaultShareModeRef,
    shellDefaultCommandRef: ctx.shellDefaultCommandRef,
    shellDefaultArgsRef: ctx.shellDefaultArgsRef,
    shellInheritEnvRef: ctx.shellInheritEnvRef,
    prepareWorkspaceStartup: ctx.prepareWorkspaceStartup,
    updateTab: mutations.updateTab,
  });

  const editor = useEditorTabActions({
    setState: ctx.setState,
    stateRef: ctx.stateRef,
    projectsRef: ctx.projectsRef,
    setActiveTab: mutations.setActiveTab,
    updateTab: mutations.updateTab,
  });

  // closeTab + closeEditorTabsForPath need the per-kind creators
  // (reopen routes back through newTab / newShellTab / newEditorTab),
  // so this factory runs *after* them.
  const close = useCloseTabActions({
    setState: ctx.setState,
    stateRef: ctx.stateRef,
    projectsRef: ctx.projectsRef,
    tabBucketsRef: ctx.tabBucketsRef,
    promptCloseShellTabConfirmation: ctx.promptCloseShellTabConfirmation,
    shellPromptBeforeCloseRef: ctx.shellPromptBeforeCloseRef,
    isShellBusy: ctx.isShellBusy,
    dispatchTerminalReplay,
    closedTabsRef,
    clearActiveProject: ctx.clearActiveProject,
    setActiveProjectById: ctx.setActiveProjectById,
    newTab,
    newShellTab,
    newEditorTab: editor.newEditorTab,
  });

  const autoRestoreDiscoveredSessions = useAutoRestoreDiscoveredSessions({
    stateRef: ctx.stateRef,
    autoRestoredSessionIdsRef,
    pushNotification: ctx.pushNotification,
    newTab,
  });

  return {
    pendingTabOpens,
    autoRestoredSessionIdsRef,
    updateTab: mutations.updateTab,
    updateActiveTab: mutations.updateActiveTab,
    applyShareModeToTab: mutations.applyShareModeToTab,
    dispatchTerminalReplay,
    setActiveTab: mutations.setActiveTab,
    setActiveSubTab: mutations.setActiveSubTab,
    newTab,
    newShellTab,
    newEditorTab: editor.newEditorTab,
    updateEditorMeta: editor.updateEditorMeta,
    toggleEditorPreview: editor.toggleEditorPreview,
    renameEditorTabsForPath: editor.renameEditorTabsForPath,
    closeEditorTabsForPath: close.closeEditorTabsForPath,
    autoRestoreDiscoveredSessions,
    pushClosedTab: close.pushClosedTab,
    reopenLastClosedTab: close.reopenLastClosedTab,
    closeTab: close.closeTab,
    closeTabNow: close.closeTabNow,
  };
}
