import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { failRunningScheduledTasksForTab } from "../../scheduledTasks";
import type { Tab } from "../../types/tab";
import { closeRunningToolCards } from "../../utils/agentBusy";
import type { NotificationInput } from "../useNotifications";

export interface AgentCrashDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  activeResponseIdRef: MutableRefObject<string | null>;
  hangWarnTimersRef: MutableRefObject<
    Map<string, ReturnType<typeof setTimeout>>
  >;
  hangWarnActiveRef: MutableRefObject<Set<string>>;
  hangWarnNotifId: (tabId: string) => string;
  dismissNotification: (id: string) => void;
  autoRestartAgentRef: MutableRefObject<boolean>;
  pushNotification: (n: NotificationInput) => string;
}

function defaultCrashDiagnostic(key?: string): string {
  return key
    ? `Agent worker exited unexpectedly (${key}).`
    : "Agent worker exited unexpectedly.";
}

function normalizeTailLine(line: string): string {
  return line.trim().replace(/^stdout:\s*/i, "").trim();
}

function isRuntimeBanner(line: string): boolean {
  return (
    /^Bun v\d+(?:\.\d+)*/i.test(line) ||
    /^Node\.js v\d+(?:\.\d+)*/i.test(line)
  );
}

function isActionableDiagnostic(line: string): boolean {
  return /fatal|panic|error|failed|timed?\s*out|timeout|exception|crash|closed unexpectedly|aborted/i.test(
    line,
  );
}

export function selectAgentCrashDiagnostic(
  tail: readonly string[],
  key?: string,
): string {
  const candidates = [...tail]
    .reverse()
    .map(normalizeTailLine)
    .filter((line) => line.length > 0 && !isRuntimeBanner(line));
  return (
    candidates.find(isActionableDiagnostic) ??
    candidates[0] ??
    defaultCrashDiagnostic(key)
  );
}

function summarizeRunningToolComponent(
  component: {
    type?: unknown;
    props?: Record<string, unknown>;
    children?: unknown[];
  },
): string | undefined {
  if (
    component.type === "tool-card" &&
    component.props?.startedAt !== undefined &&
    component.props.endedAt === undefined
  ) {
    const toolName = String(
      component.props.toolName ?? component.props.title ?? "tool",
    ).trim();
    const description =
      typeof component.props.description === "string"
        ? component.props.description.trim()
        : "";
    return [toolName, description].filter(Boolean).join(" ");
  }
  for (const child of component.children ?? []) {
    if (!child || typeof child !== "object") continue;
    const summary = summarizeRunningToolComponent(child);
    if (summary) return summary;
  }
  return undefined;
}

export function summarizeRunningToolCrash(
  tabs: readonly Tab[] | undefined,
  crashedTabId?: string,
): string | undefined {
  if (!crashedTabId) return undefined;
  const matchingTabs = (tabs ?? []).filter(
    (tab) =>
      (tab.kind ?? "agent") === "agent" &&
      tab.id === crashedTabId,
  );
  for (const tab of matchingTabs) {
    for (const message of tab.messages ?? []) {
      for (const component of message.a2ui?.components ?? []) {
        const summary = summarizeRunningToolComponent(component);
        if (summary) return summary;
      }
    }
  }
  return undefined;
}

/** P5 bridge crash recovery. The Rust supervisor emits this when the
 *  bun child exits unexpectedly (intentional hot-reload kills go
 *  through `agent-reloaded` instead). Clears per-tab waiting state,
 *  drops any matching hang-warn timer, pops a notification, and
 *  auto-restarts the process if [shell.autoRestartAgent] is set.
 *
 *  Per-tab crash (`tabId` set) clears only that tab's state; a
 *  global crash (`tabId` null) clears everything because app-wide
 *  state is gone. */
export function subscribeAgentCrash(deps: AgentCrashDeps): () => void {
  const {
    setState,
    stateRef,
    activeResponseIdRef,
    hangWarnTimersRef,
    hangWarnActiveRef,
    hangWarnNotifId,
    dismissNotification,
    autoRestartAgentRef,
    pushNotification,
  } = deps;

  // Respawn helper. Falls back to a bare `start_agent` when no tab
  // was supplied; otherwise re-opens the affected agent tab with its
  // saved cwd + model so pi's SessionManager picks up the existing
  // session file.
  const restartAgentProcess = (tabId?: string) => {
    if (!tabId) {
      return invoke("start_agent");
    }
    const tab = ((stateRef.current.tabs as Tab[] | undefined) ?? []).find(
      (t) => t.id === tabId && t.kind === "agent",
    );
    const payload: Record<string, unknown> = { type: "tab_open", tabId };
    if (tab?.cwd) payload.cwd = tab.cwd;
    if (tab?.model) payload.model = tab.model;
    return invoke("agent_command", { payload: JSON.stringify(payload) });
  };

  const unlistenCrashed = listen<{
    pid?: number;
    key?: string;
    tabId?: string | null;
    stderrTail?: string[];
  }>("agent-crashed", (event) => {
    const tail = event.payload?.stderrTail ?? [];
    const crashedKey = event.payload?.key;
    const crashedTabId =
      typeof event.payload?.tabId === "string" &&
      event.payload.tabId.length > 0
        ? event.payload.tabId
        : undefined;
    const globalOnlyCrash = !crashedTabId && crashedKey === "__global__";
    const diagnostic = selectAgentCrashDiagnostic(tail, crashedKey);
    const runningTool = summarizeRunningToolCrash(
      (stateRef.current.tabs as Tab[] | undefined) ?? [],
      crashedTabId,
    );
    const crashMessage = runningTool
      ? `${runningTool} did not finish before the agent worker exited. ${diagnostic}`
      : diagnostic;
    if (crashedTabId || !globalOnlyCrash) {
      void failRunningScheduledTasksForTab({
        tabId: crashedTabId ?? null,
        message: crashMessage,
      }).catch(() => {
        /* scheduler state will recover from persisted running state on restart */
      });
    }
    activeResponseIdRef.current = null;
    if (crashedTabId) {
      const h = hangWarnTimersRef.current.get(crashedTabId);
      if (h !== undefined) clearTimeout(h);
      hangWarnTimersRef.current.delete(crashedTabId);
      if (hangWarnActiveRef.current.delete(crashedTabId)) {
        dismissNotification(hangWarnNotifId(crashedTabId));
      }
    } else {
      for (const h of hangWarnTimersRef.current.values()) clearTimeout(h);
      hangWarnTimersRef.current.clear();
      for (const tid of hangWarnActiveRef.current)
        dismissNotification(hangWarnNotifId(tid));
      hangWarnActiveRef.current.clear();
    }
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).map((t) => {
        if (globalOnlyCrash) return t;
        if (crashedTabId && t.id !== crashedTabId) return t;
        const closedTools = closeRunningToolCards(t.messages, {
          notice: crashMessage,
        });
        return {
          ...t,
          waiting: false,
          queueCount: 0,
          ...(closedTools.changed ? { messages: closedTools.messages } : {}),
        };
      });
      // Drop the crashed tab(s) from the bucket-independent running set so the
      // sidebar activity dot can't stay stuck — a crash doesn't emit
      // response_end. A whole-process crash (no crashedTabId) aborts every
      // in-flight turn, including backgrounded ones.
      const prevRunning =
        (prev.agentRunningTabs as Record<string, true> | undefined) ?? {};
      let agentRunningTabs: Record<string, true>;
      if (globalOnlyCrash) {
        agentRunningTabs = prevRunning;
      } else if (crashedTabId) {
        agentRunningTabs = { ...prevRunning };
        delete agentRunningTabs[crashedTabId];
      } else {
        agentRunningTabs = {};
      }
      return {
        ...prev,
        tabs,
        agentRunningTabs,
        ...(!globalOnlyCrash && (!crashedTabId || prev.activeTabId === crashedTabId)
          ? { waiting: false, queueCount: 0 }
          : {}),
        status: globalOnlyCrash ? "agent reloading" : "agent crashed",
      };
    });
    const willAutoRestart = autoRestartAgentRef.current;
    const notificationId = crashedTabId
      ? `ae-agent-crashed:${crashedTabId}`
      : "ae-agent-crashed";
    pushNotification({
      id: notificationId,
      title: "Agent process exited unexpectedly",
      message: crashMessage.slice(0, 240),
      kind: "error",
      // Keep visible until dismissed or restart succeeds — a transient
      // toast would race a user away from the keyboard while a long
      // turn died.
      durationMs: null,
      actions: willAutoRestart
        ? [{ label: "Dismiss", action: "ae-agent-crashed:dismiss" }]
        : [
            {
              label: "Restart",
              action: crashedTabId
                ? `ae-agent-crashed:restart:${crashedTabId}`
                : "ae-agent-crashed:restart",
            },
            { label: "Dismiss", action: "ae-agent-crashed:dismiss" },
          ],
    });
    if (willAutoRestart) {
      // Brief delay so the user sees the notice flash before the next
      // request silently respawns. The next chat send would respawn
      // via ensure_agent_spawned anyway; priming here means the
      // system-prompt + ready handshake happens up-front.
      window.setTimeout(() => {
        restartAgentProcess(crashedTabId).catch(() => {
          /* respawn deferred to next user action */
        });
      }, 500);
    }
  });

  return () => {
    unlistenCrashed.then((fn) => fn());
  };
}
