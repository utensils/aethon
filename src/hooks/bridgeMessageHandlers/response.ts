import { closeRunningToolCards } from "../../utils/agentBusy";
import { clearAgentActivity } from "./agentActivity";
import { clearHangWarn } from "./hangWarn";
import type { BridgeMessageHandler } from "./types";

/** Legacy single-shot response (kept so old bridge builds still render). */
export const handleResponse: BridgeMessageHandler = (data, ctx) => {
  const content = (data.content as string) ?? "";
  const tabId = (data.tabId as string | undefined) ?? "default";
  if (content) {
    clearAgentActivity(ctx, tabId);
    ctx.appendMessage(
      { id: crypto.randomUUID(), role: "agent", text: content },
      tabId,
    );
  }
  if (data.done) {
    clearAgentActivity(ctx, tabId);
    ctx.updateTab(tabId, (tab) => {
      const closedTools = closeRunningToolCards(tab.messages);
      return {
        ...tab,
        waiting: false,
        ...(closedTools.changed ? { messages: closedTools.messages } : {}),
      };
    });
    if (ctx.stateRef.current.activeTabId === tabId) {
      ctx.setStatusFlags({ status: "ready" });
    }
    ctx.setState((prev) => {
      const running = prev.agentRunningTabs as Record<string, true> | undefined;
      if (!running || !running[tabId]) return prev;
      const next = { ...running };
      delete next[tabId];
      return { ...prev, agentRunningTabs: next };
    });
    clearHangWarn(ctx, tabId);
  }
};
