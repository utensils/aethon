import {
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type ClosedTabEntry,
  type ShellMeta,
  type Tab,
  makeEmptyTab,
} from "../types/tab";
import {
  activeProject,
  type ProjectsState,
} from "../projects";
import { getConfig } from "../config";
import { recomputeModelPicker } from "../utils/modelPicker";

/** Per-tab terminal buffer cap. Bash output bursts can be huge; without
 *  a ceiling the buffer would grow forever and slow tab switches as the
 *  replay payload grows. Exported so bridge / shell-output handlers
 *  outside this hook trim against the same limit. */
export const TERMINAL_REPLAY_MAX = 256 * 1024;

/** Tab fields that ride along on the root state. Bound by layout JSON
 *  via `$ref` so /messages, /draft, etc. always reflect the active
 *  tab without per-binding rewrites on every render. */
export const TAB_MIRROR_KEYS: (keyof Tab)[] = [
  "messages",
  "draft",
  "waiting",
  "queueCount",
  "canvas",
  "model",
  // M6 P1: shell-tab fields. The "kind" + "shell" mirror lets layouts
  // bind `visible: { $ref: "/kind" }`-style toggles without running a
  // full /tabs/<idx> lookup on every render.
  "kind",
  "shell",
];

const CLOSED_TAB_STACK_MAX = 10;
const VALID_SHARE_MODES: ShellMeta["shareMode"][] = [
  "private",
  "read",
  "read-write",
  "read-write-trusted",
];

interface DiscoveredSession {
  tabId: string;
  lastModified: number;
  cwd?: string;
  firstUserMessage?: string;
  customLabel?: string;
}

interface NotificationInput {
  id: string;
  title: string;
  message?: string;
  kind?: "info" | "success" | "warning" | "error";
  durationMs?: number | null;
}

export interface UseTabsContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  pushNotification: (n: NotificationInput) => void;
  appendSystem: (text: string) => void;
  /** Resolves true on Allow / false on Cancel|dismiss. Drives the
   *  prompt-before-close gate for running shell tabs. */
  promptCloseShellTabConfirmation: (tabLabel: string) => Promise<boolean>;
  /** Live ref to projects state so newTab/newShellTab inherit the active
   *  project's path as cwd. Project bucket swap stays in App.tsx. */
  projectsRef: MutableRefObject<ProjectsState>;
  /** Default model id from pi `ready`. New tabs inherit this when no per-
   *  tab model has been set, preventing a blank picker on race startup. */
  piDefaultModelRef: MutableRefObject<string>;
  /** Reopen-flow callbacks: when the closed tab belongs to a different
   *  project bucket, switch buckets first so it lands in the correct
   *  visible tab list. */
  clearActiveProject: () => void;
  setActiveProjectById: (id: string) => boolean;
  /** Live shell config from getConfig() — set by the boot config effect
   *  and the settings panel apply path. The hook reads via `.current`. */
  defaultShareModeRef: MutableRefObject<ShellMeta["shareMode"]>;
  shellDefaultCommandRef: MutableRefObject<string | null>;
  shellDefaultArgsRef: MutableRefObject<string[]>;
  shellInheritEnvRef: MutableRefObject<boolean>;
  shellPromptBeforeCloseRef: MutableRefObject<boolean>;
}

export interface UseTabsActions {
  /** In-flight tab_open promises keyed by tabId. sendChat awaits this so
   *  the bridge can't race-create the tab via the chat path. */
  pendingTabOpens: MutableRefObject<Map<string, Promise<unknown>>>;
  /** Tab ids the auto-restore path has already opened in this session.
   *  Prevents a second restore wave from re-opening the same tab. */
  autoRestoredSessionIdsRef: MutableRefObject<Set<string>>;

  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  updateActiveTab: (mutator: (tab: Tab) => Tab) => void;
  applyShareModeToTab: (tabId: string, mode: string) => void;

  dispatchTerminalReplay: (buffer: string) => void;
  setActiveTab: (tabId: string) => void;
  setActiveSubTab: (subId: string) => void;

  newTab: (
    restoreId?: string,
    restoreLabel?: string,
    options?: { restoredSession?: boolean; cwd?: string; scrollToMatch?: string },
  ) => void;
  newShellTab: (options?: {
    command?: string;
    args?: string[];
    cwd?: string;
  }) => void;
  autoRestoreDiscoveredSessions: (
    discovered: DiscoveredSession[],
    knownIds: Set<string>,
  ) => void;

  pushClosedTab: (tab: Tab) => void;
  reopenLastClosedTab: () => void;
  closeTab: (tabId: string) => void;
  closeTabNow: (tabId: string) => void;
}

/**
 * Tab lifecycle: create (newTab/newShellTab), switch (setActiveTab/
 * setActiveSubTab), update (updateTab/updateActiveTab), close
 * (closeTab/closeTabNow), and undo-close (pushClosedTab/
 * reopenLastClosedTab).
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
  const {
    setState,
    stateRef,
    pushNotification,
    appendSystem,
    promptCloseShellTabConfirmation,
    projectsRef,
    piDefaultModelRef,
    clearActiveProject,
    setActiveProjectById,
    defaultShareModeRef,
    shellDefaultCommandRef,
    shellDefaultArgsRef,
    shellInheritEnvRef,
    shellPromptBeforeCloseRef,
  } = ctx;

  const pendingTabOpens = useRef(new Map<string, Promise<unknown>>());
  const closedTabsRef = useRef<ClosedTabEntry[]>([]);
  const autoRestoredSessionIdsRef = useRef(new Set<string>());

  function updateTab(tabId: string, mutator: (tab: Tab) => Tab) {
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = mutator(tabs[idx]);
      tabs[idx] = next;
      const result: Record<string, unknown> = { ...prev, tabs };
      if (prev.activeTabId === tabId) {
        const nextRec = next as unknown as Record<string, unknown>;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = nextRec[key as string];
        }
      }
      return result;
    });
  }

  function updateActiveTab(mutator: (tab: Tab) => Tab) {
    setState((prev) => {
      const activeId = prev.activeTabId as string | undefined;
      if (!activeId) return prev;
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const idx = tabs.findIndex((t) => t.id === activeId);
      if (idx < 0) return prev;
      const next = mutator(tabs[idx]);
      tabs[idx] = next;
      const result: Record<string, unknown> = { ...prev, tabs };
      const nextRec = next as unknown as Record<string, unknown>;
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = nextRec[key as string];
      }
      return result;
    });
  }

  /** Mirror a share-mode change from the Rust source-of-truth into the
   *  React Tab record. Cheap no-op if the tab doesn't exist or isn't a
   *  shell tab. The Rust side enforces the actual privacy boundary —
   *  this just keeps the badge UI honest. */
  function applyShareModeToTab(tabId: string, mode: string) {
    if (!tabId) return;
    if (!VALID_SHARE_MODES.includes(mode as ShellMeta["shareMode"])) return;
    updateTab(tabId, (t) => {
      if (t.kind !== "shell" || !t.shell) return t;
      if (t.shell.shareMode === mode) return t;
      return {
        ...t,
        shell: {
          ...t.shell,
          shareMode: mode as ShellMeta["shareMode"],
        },
      };
    });
  }

  /** Tell the shared xterm panel to clear and replay a tab's terminal
   *  buffer. Microtask deferral so xterm's mount-once useEffect has
   *  resolved before we try to write to it. */
  function dispatchTerminalReplay(buffer: string) {
    Promise.resolve().then(() => {
      window.dispatchEvent(
        new CustomEvent("aethon:terminal-replay", { detail: buffer }),
      );
    });
  }

  /** Switch the active tab. Re-mirrors the new tab's view to the root
   *  keys so layout bindings update without per-key refresh, plus
   *  dispatches a terminal replay so the shared xterm clears and
   *  re-writes the new tab's buffered output. */
  function setActiveTab(tabId: string) {
    let nextBuffer = "";
    setState((prev) => {
      const tabs = (prev.tabs as Tab[] | undefined) ?? [];
      const target = tabs.find((t) => t.id === tabId);
      if (!target) return prev;
      nextBuffer = target.terminalBuffer ?? "";
      const result: Record<string, unknown> = { ...prev, activeTabId: tabId };
      const targetRec = target as unknown as Record<string, unknown>;
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = targetRec[key as string];
      }
      result.sidebar = recomputeModelPicker(
        prev.sidebar as Record<string, unknown> | undefined,
        target.model,
      );
      return result;
    });
    dispatchTerminalReplay(nextBuffer);
  }

  /** Switch which sub-tab is active in the bottom terminal panel. Sub-tab
   *  id is either "agent-bash" or a shell tab id from /tabs. Auto-opens
   *  the panel if hidden. When switching back to agent-bash, replay the
   *  active agent tab's terminalBuffer so the freshly-mounted Terminal
   *  composite sees its content. */
  function setActiveSubTab(subId: string) {
    setState((prev) => {
      const panel =
        (prev.terminalPanel as { activeSubId?: string } | undefined) ?? {};
      const term = (prev.terminal as { open?: boolean } | undefined) ?? {};
      if (panel.activeSubId === subId && term.open === true) {
        return prev;
      }
      return {
        ...prev,
        terminalPanel: { ...panel, activeSubId: subId },
        terminal: { ...term, open: true },
      };
    });
    if (subId === "agent-bash") {
      requestAnimationFrame(() => {
        const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
        const activeId = stateRef.current.activeTabId as string | undefined;
        const active = activeId ? tabs.find((t) => t.id === activeId) : undefined;
        const buffer = active?.terminalBuffer ?? "";
        dispatchTerminalReplay(buffer);
      });
    }
  }

  function newTab(
    restoreId?: string,
    restoreLabel?: string,
    options?: {
      restoredSession?: boolean;
      cwd?: string;
      scrollToMatch?: string;
    },
  ) {
    // restoreId lets the caller open a tab with a specific tabId so the
    // bridge's SessionManager.continueRecent picks up the persisted
    // session for that id. Used by the empty-state's "Recent sessions"
    // list. Omitted for normal new-tab gestures (Cmd+T, +, menu).
    const id = restoreId ?? crypto.randomUUID();
    // Search-hit scroll target. Stored in /scrollToMatchByTab/<id> so
    // ChatHistory picks it up once the bridge replays messages. Null
    // out the entry after a few seconds so a user who scrolls away
    // doesn't keep getting yanked back.
    const scrollToMatch = options?.scrollToMatch;
    if (scrollToMatch) {
      setState((prev) => {
        const cur =
          (prev.scrollToMatchByTab as Record<string, string> | undefined) ?? {};
        return {
          ...prev,
          scrollToMatchByTab: { ...cur, [id]: scrollToMatch },
        };
      });
      window.setTimeout(() => {
        setState((prev) => {
          const cur =
            (prev.scrollToMatchByTab as Record<string, string> | undefined) ??
            {};
          if (!(id in cur)) return prev;
          const next = { ...cur };
          delete next[id];
          return { ...prev, scrollToMatchByTab: next };
        });
      }, 5000);
    }
    // Inherit the previously-active tab's model so the picker stays
    // consistent. Fall back to piDefaultModelRef so tabs opened before
    // ready still get a valid model.
    const inheritedModel = (
      (stateRef.current.model as string | undefined) ||
      piDefaultModelRef.current
    ).trim();
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const label = restoreLabel ?? `Tab ${tabs.length + 1}`;
      const projectId = projectsRef.current.activeId;
      const tab: Tab = {
        ...makeEmptyTab(id, label, projectId),
        model: inheritedModel,
      };
      tabs.push(tab);
      const result: Record<string, unknown> = {
        ...prev,
        tabs,
        activeTabId: id,
        empty: false,
        hasTabs: true,
      };
      const tabRec = tab as unknown as Record<string, unknown>;
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = tabRec[key as string];
      }
      result.sidebar = recomputeModelPicker(
        prev.sidebar as Record<string, unknown> | undefined,
        tab.model,
      );
      return result;
    });
    // Clear the shared xterm so it doesn't keep showing the previous
    // tab's scrollback until the next switch / output event.
    dispatchTerminalReplay("");
    const inheritedCwd =
      options?.cwd ?? activeProject(projectsRef.current)?.path;
    const opening = invoke("agent_command", {
      payload: JSON.stringify({
        type: "tab_open",
        tabId: id,
        ...(inheritedModel ? { model: inheritedModel } : {}),
        ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
        ...(options?.restoredSession ? { restoreHistory: true } : {}),
      }),
    });
    pendingTabOpens.current.set(id, opening);
    opening
      .catch((err) => {
        appendSystem(`Failed to open tab: ${err}`);
      })
      .finally(() => {
        pendingTabOpens.current.delete(id);
      });
  }

  function newShellTab(options?: {
    command?: string;
    args?: string[];
    cwd?: string;
  }) {
    const id = crypto.randomUUID();
    const inheritedCwd =
      options?.cwd ?? activeProject(projectsRef.current)?.path;
    const seedShareMode = defaultShareModeRef.current;
    const resolvedCommand =
      options?.command ?? shellDefaultCommandRef.current ?? undefined;
    const resolvedArgs =
      options?.args ??
      (shellDefaultArgsRef.current.length > 0
        ? shellDefaultArgsRef.current
        : undefined);
    const inheritEnv = shellInheritEnvRef.current;
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const label = `Shell ${tabs.filter((t) => t.kind === "shell").length + 1}`;
      const projectId = projectsRef.current.activeId;
      const tab: Tab = {
        ...makeEmptyTab(id, label, projectId, "shell"),
        shell: {
          cwd: inheritedCwd ?? "",
          command: resolvedCommand ?? "",
          args: resolvedArgs ?? [],
          shareMode: seedShareMode,
          shellState: "starting",
        },
      };
      tabs.push(tab);
      // M6 restructure: shells live in the bottom panel as sub-tabs,
      // not the top tab strip. Don't promote to /activeTabId — that
      // stays on the user's agent tab. Instead, open the panel and
      // make this shell the active sub-tab so the user sees it.
      const panel =
        (prev.terminalPanel as { activeSubId?: string } | undefined) ?? {};
      const term = (prev.terminal as { open?: boolean } | undefined) ?? {};
      return {
        ...prev,
        tabs,
        terminalPanel: { ...panel, activeSubId: id },
        terminal: { ...term, open: true },
      };
    });
    invoke("shell_open", {
      args: {
        tabId: id,
        ...(resolvedCommand ? { command: resolvedCommand } : {}),
        ...(resolvedArgs ? { args: resolvedArgs } : {}),
        ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
        // Seed the share mode atomically inside shell_open so the
        // privacy floor pins at total_appended=0 — every byte from the
        // first prompt forward is visible to the agent when the user
        // configured a non-private default. Applying the mode post-open
        // would race the login banner and pin it below the floor.
        ...(seedShareMode !== "private" ? { shareMode: seedShareMode } : {}),
        ...(inheritEnv === false ? { inheritEnv: false } : {}),
      },
    })
      .then(() => {
        updateTab(id, (t) => ({
          ...t,
          shell: t.shell ? { ...t.shell, shellState: "running" } : t.shell,
        }));
      })
      .catch((err: unknown) => {
        appendSystem(`Failed to open shell tab: ${String(err)}`);
        updateTab(id, (t) => ({
          ...t,
          shell: t.shell
            ? { ...t.shell, shellState: "exited", exitCode: -1 }
            : t.shell,
        }));
      });
  }

  function autoRestoreDiscoveredSessions(
    discovered: DiscoveredSession[],
    knownIds: Set<string>,
  ) {
    if (discovered.length === 0) return;
    getConfig()
      .then((config) => {
        if (!config.ui.restoreTabs) return;
        const liveIds = new Set([
          ...knownIds,
          ...(((stateRef.current.tabs as Tab[] | undefined) ?? []).map(
            (t) => t.id,
          )),
        ]);
        const toRestore = discovered
          .filter((d) => !liveIds.has(d.tabId))
          .filter((d) => !autoRestoredSessionIdsRef.current.has(d.tabId))
          .slice(0, 8);
        if (toRestore.length === 0) return;
        // Open oldest first so the most recent session ends up active.
        for (const session of [...toRestore].reverse()) {
          autoRestoredSessionIdsRef.current.add(session.tabId);
          newTab(session.tabId, `Session ${session.tabId.slice(0, 8)}`, {
            restoredSession: true,
            ...(session.cwd ? { cwd: session.cwd } : {}),
          });
        }
        pushNotification({
          id: "ae-auto-restore-tabs",
          title: `Restored ${toRestore.length} session${toRestore.length === 1 ? "" : "s"}`,
          kind: "success",
          durationMs: 3000,
        });
      })
      .catch(() => {
        /* config read already logs; manual restore remains available */
      });
  }

  function pushClosedTab(tab: Tab) {
    const entry: ClosedTabEntry = {
      id: tab.id,
      kind: tab.kind,
      label: tab.label,
      projectId: tab.projectId,
      ...(tab.kind === "shell" && tab.shell
        ? {
            cwd: tab.shell.cwd,
            command: tab.shell.command,
            args: tab.shell.args,
          }
        : {}),
    };
    closedTabsRef.current.push(entry);
    if (closedTabsRef.current.length > CLOSED_TAB_STACK_MAX) {
      closedTabsRef.current.splice(
        0,
        closedTabsRef.current.length - CLOSED_TAB_STACK_MAX,
      );
    }
  }

  /** Reopen the most-recently-closed tab. Agent tabs reopen with the
   *  *original* tabId — that's the cue for the bridge's
   *  SessionManager.continueRecent to pick up the persisted JSONL session
   *  under `~/.aethon/sessions/<tabId>/`. Shell tabs spawn a fresh PTY
   *  at the original cwd. No-op on empty stack. */
  function reopenLastClosedTab() {
    const entry = closedTabsRef.current.pop();
    if (!entry) return;
    // If the closed tab belongs to a different project bucket than
    // the active one, switch to that bucket first so the new tab
    // lands in its original project's tab list.
    const activeId = projectsRef.current.activeId;
    if (entry.projectId !== activeId) {
      if (entry.projectId === null) {
        clearActiveProject();
      } else {
        setActiveProjectById(entry.projectId);
      }
    }
    if (entry.kind === "shell") {
      newShellTab({
        ...(entry.command ? { command: entry.command } : {}),
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
      });
    } else {
      newTab(entry.id, entry.label, { restoredSession: true });
    }
  }

  /** Close a tab, prompting for confirmation when closing a running
   *  shell tab and `[shell] prompt_before_close` is true. */
  function closeTab(tabId: string) {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const closing = tabs.find((t) => t.id === tabId);
    if (
      closing?.kind === "shell" &&
      closing.shell?.shellState === "running" &&
      shellPromptBeforeCloseRef.current
    ) {
      void promptCloseShellTabConfirmation(closing.label).then((allowed) => {
        if (!allowed) return;
        closeTabNow(tabId);
      });
      return;
    }
    closeTabNow(tabId);
  }

  function closeTabNow(tabId: string) {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    if (tabs.length === 0) return;
    const closing = tabs.find((t) => t.id === tabId);
    const closedKind = closing?.kind;
    if (closing) pushClosedTab(closing);
    let nextBuffer = "";
    let switched = false;
    let becameEmpty = false;
    setState((prev) => {
      const list = ((prev.tabs as Tab[] | undefined) ?? []).filter(
        (t) => t.id !== tabId,
      );
      let activeTabId = prev.activeTabId as string | undefined;
      if (activeTabId === tabId) {
        activeTabId = list.length > 0 ? list[list.length - 1].id : undefined;
        switched = true;
      }
      const result: Record<string, unknown> = {
        ...prev,
        tabs: list,
        activeTabId,
      };
      if (list.length === 0) {
        becameEmpty = true;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = undefined;
        }
        result.empty = true;
        result.hasTabs = false;
      } else {
        const target = list.find((t) => t.id === activeTabId)!;
        nextBuffer = target.terminalBuffer ?? "";
        const targetRec = target as unknown as Record<string, unknown>;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = targetRec[key as string];
        }
        result.sidebar = recomputeModelPicker(
          prev.sidebar as Record<string, unknown> | undefined,
          target.model,
        );
        result.empty = false;
        result.hasTabs = true;
      }
      return result;
    });
    if (switched) dispatchTerminalReplay(nextBuffer);
    // Tear down bridge session whether we became empty or not — both
    // paths fire tab_close and the bridge no-ops on unknown tab ids.
    void becameEmpty;
    invoke("agent_command", {
      payload: JSON.stringify({ type: "tab_close", tabId }),
    }).catch(() => {
      /* ignore — UI already closed */
    });
    // M6 P1: shell tabs own a PTY in the Rust shell registry. Close
    // it too so the child process is reaped and the reader thread
    // joins (no zombies on tab close).
    if (closedKind === "shell") {
      invoke("shell_close", { tabId }).catch(() => {
        /* idempotent — already torn down by natural exit */
      });
    }
  }

  return {
    pendingTabOpens,
    autoRestoredSessionIdsRef,
    updateTab,
    updateActiveTab,
    applyShareModeToTab,
    dispatchTerminalReplay,
    setActiveTab,
    setActiveSubTab,
    newTab,
    newShellTab,
    autoRestoreDiscoveredSessions,
    pushClosedTab,
    reopenLastClosedTab,
    closeTab,
    closeTabNow,
  };
}
