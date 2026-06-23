import { invoke } from "@tauri-apps/api/core";

import type { ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";
import {
  hydrateAgentActivityState,
  type AgentDiagnosticRow,
} from "./useAgentActivityHydration";
import { queueOf, withQueue } from "./chatQueue";
import type { UseChatContext } from "./useChat";

export const STOP_CONFIRM_DELAYS_MS = [0, 150, 500, 1000, 2000] as const;

export function diagnosticMatchesTab(row: AgentDiagnosticRow, tabId: string) {
  return (
    row.tab_id === tabId ||
    row.tabId === tabId ||
    row.key === `tab:${tabId}` ||
    (tabId === "default" && row.key === "__global__")
  );
}

export interface StopPromptDeps {
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  setStatusFlags: (
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) => void;
}

export interface StopPromptController {
  stopPrompt: (explicitTabId?: string) => Promise<void>;
}

export function createStopPromptController(
  ctx: Pick<UseChatContext, "setState" | "stateRef" | "updateTab">,
  deps: StopPromptDeps,
): StopPromptController {
  const { setState, stateRef, updateTab } = ctx;
  const { appendMessage, setStatusFlags } = deps;

  async function confirmPromptStopped(tabId: string) {
    for (const delay of STOP_CONFIRM_DELAYS_MS) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      let diagnostics: AgentDiagnosticRow[];
      try {
        const result = await invoke<AgentDiagnosticRow[]>("agent_diagnostics");
        if (!Array.isArray(result)) return;
        diagnostics = result;
      } catch {
        return;
      }
      const row = diagnostics.find((entry) =>
        diagnosticMatchesTab(entry, tabId),
      );
      if (!row) continue;
      const promptInFlight =
        row.prompt_in_flight === true || row.promptInFlight === true;
      if (row.alive !== false && promptInFlight) continue;
      const stoppedMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "system",
        text: "Agent stopped.",
        createdAt: Date.now(),
      };
      setState((prev) => {
        const hydrated = hydrateAgentActivityState(prev, diagnostics, {
          trustNegativeDiagnosticsForTabIds: new Set([tabId]),
          closeStaleToolCardsForTabIds: new Set([tabId]),
        });
        const tabs = (hydrated.tabs as Tab[] | undefined) ?? [];
        const nextTabs = tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, messages: [...tab.messages, stoppedMessage] }
            : tab,
        );
        return hydrated.activeTabId === tabId
          ? {
              ...hydrated,
              status: "stopped",
              messages: [
                ...((hydrated.messages as ChatMessage[]) ?? []),
                stoppedMessage,
              ],
              tabs: nextTabs,
            }
          : { ...hydrated, tabs: nextTabs };
      });
      return;
    }
  }

  async function stopPrompt(explicitTabId?: string) {
    const tabId =
      explicitTabId ??
      (stateRef.current.activeTabId as string | undefined) ??
      "default";
    // The composer's Stop button advertises "Stop + clear" when the
    // queue is non-empty; clear the client-held queue here so a user
    // who stopped because they wanted *out* of the train can't have
    // the next queued message drain on the following idle.
    updateTab(tabId, (tab) =>
      queueOf(tab).length === 0 ? tab : withQueue(tab, []),
    );
    try {
      await invoke("agent_command", {
        payload: JSON.stringify({ type: "stop", tabId }),
      });
      setStatusFlags({ status: "stopping…" });
      await confirmPromptStopped(tabId);
    } catch (err) {
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to stop: ${err}`,
        },
        tabId,
      );
    }
  }

  return { stopPrompt };
}
