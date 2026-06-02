import { useEffect, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { A2UIComponent, ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";
import { TAB_MIRROR_KEYS } from "./useTabs";

export const AGENT_ACTIVITY_HYDRATION_RETRY_DELAYS_MS = [
  0, 250, 1000, 2500, 5000, 10000,
] as const;

export interface AgentDiagnosticRow {
  key: string;
  tab_id?: string | null;
  tabId?: string | null;
  alive?: boolean;
  prompt_in_flight?: boolean;
  promptInFlight?: boolean;
}

function diagnosticTabId(row: AgentDiagnosticRow): string | null {
  if (typeof row.tab_id === "string" && row.tab_id.length > 0) {
    return row.tab_id;
  }
  if (typeof row.tabId === "string" && row.tabId.length > 0) {
    return row.tabId;
  }
  if (row.key === "__global__") return "default";
  if (row.key.startsWith("tab:")) return row.key.slice("tab:".length);
  return null;
}

function diagnosticPromptInFlight(row: AgentDiagnosticRow): boolean {
  return row.prompt_in_flight === true || row.promptInFlight === true;
}

function stoppedToolCardNotice(componentId: string): A2UIComponent {
  return {
    id: `${componentId}-stopped-notice`,
    type: "code",
    props: {
      content:
        "No live prompt is running. This tool was marked stopped after reload.",
      language: "text",
    },
  };
}

function closeStoppedToolCards(
  messages: ChatMessage[],
  endedAt: number,
): { messages: ChatMessage[]; changed: boolean } {
  let changed = false;
  const nextMessages = messages.map((message): ChatMessage => {
    const components = message.a2ui?.components;
    if (!components) return message;
    let messageChanged = false;
    const nextComponents = components.map((component): A2UIComponent => {
      if (
        component?.type !== "tool-card" ||
        component.props?.startedAt === undefined ||
        component.props.endedAt !== undefined
      ) {
        return component;
      }
      messageChanged = true;
      const children = component.children ?? [];
      return {
        ...component,
        props: {
          ...(component.props ?? {}),
          status: "cancelled",
          endedAt,
        },
        children: [...children, stoppedToolCardNotice(component.id)],
      };
    });
    if (!messageChanged) return message;
    changed = true;
    return {
      ...message,
      a2ui: {
        ...message.a2ui,
        components: nextComponents,
      },
    };
  });
  return { messages: nextMessages, changed };
}

export function hydrateAgentActivityState(
  state: Record<string, unknown>,
  diagnostics: AgentDiagnosticRow[],
): Record<string, unknown> {
  const tabs = (state.tabs as Tab[] | undefined) ?? [];
  if (tabs.length === 0) return state;

  const livePromptByTabId = new Map<string, boolean>();
  for (const row of diagnostics) {
    if (row.alive === false) continue;
    const tabId = diagnosticTabId(row);
    if (!tabId) continue;
    livePromptByTabId.set(
      tabId,
      (livePromptByTabId.get(tabId) ?? false) ||
        diagnosticPromptInFlight(row),
    );
  }
  let tabChanged = false;
  const endedAt = Date.now();
  const nextTabs = tabs.map((tab) => {
    if ((tab.kind ?? "agent") !== "agent") return tab;
    const hasDiagnostic = livePromptByTabId.has(tab.id);
    const nextWaiting = hasDiagnostic
      ? livePromptByTabId.get(tab.id) === true
      : false;
    const stoppedTools = nextWaiting
      ? { messages: tab.messages, changed: false }
      : closeStoppedToolCards(tab.messages, endedAt);
    if (tab.waiting === nextWaiting && !stoppedTools.changed) return tab;
    tabChanged = true;
    return { ...tab, waiting: nextWaiting, messages: stoppedTools.messages };
  });

  const activeTabId = state.activeTabId as string | undefined;
  const activeTab = nextTabs.find((tab) => tab.id === activeTabId);
  const activeRecord =
    (activeTab as unknown as Record<string, unknown> | undefined) ?? {};
  const activeTurnBusy =
    activeTab?.waiting === true || (activeTab?.queueCount ?? 0) > 0;
  const nextStatus = activeTurnBusy ? "thinking…" : "ready";
  const statusChanged = !!activeTab && state.status !== nextStatus;
  const mirrorChanged =
    !!activeTab &&
    TAB_MIRROR_KEYS.some(
      (key) => state[key as string] !== activeRecord[key as string],
    );
  if (!tabChanged && !statusChanged && !mirrorChanged) return state;

  const next: Record<string, unknown> = {
    ...state,
    ...(tabChanged ? { tabs: nextTabs } : {}),
    ...(activeTab ? { status: nextStatus } : {}),
  };
  if (activeTab) {
    for (const key of TAB_MIRROR_KEYS) {
      next[key as string] = activeRecord[key as string];
    }
  }
  return next;
}

export function useAgentActivityHydration(
  setState: Dispatch<SetStateAction<Record<string, unknown>>>,
): void {
  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const hydrate = () => {
      invoke<AgentDiagnosticRow[]>("agent_diagnostics")
        .then((diagnostics) => {
          if (cancelled || !Array.isArray(diagnostics)) return;
          setState((prev) => hydrateAgentActivityState(prev, diagnostics));
        })
        .catch(() => {
          /* Older/dev-mismatched shells may not expose diagnostics. */
        });
    };

    for (const delay of AGENT_ACTIVITY_HYDRATION_RETRY_DELAYS_MS) {
      timers.push(setTimeout(hydrate, delay));
    }
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [setState]);
}
