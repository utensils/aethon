import { closeRunningToolCards } from "../../utils/agentBusy";
import type { BridgeMessageHandler } from "./types";

/** Legacy single-shot response (kept so old bridge builds still render). */
export const handleResponse: BridgeMessageHandler = (data, ctx) => {
  const content = (data.content as string) ?? "";
  const tabId = (data.tabId as string | undefined) ?? "default";
  if (content) {
    ctx.appendMessage(
      { id: crypto.randomUUID(), role: "agent", text: content },
      tabId,
    );
  }
  if (data.done) {
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
  }
};
