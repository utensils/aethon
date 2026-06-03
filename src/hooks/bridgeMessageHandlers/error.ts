import { closeRunningToolCards } from "../../utils/agentBusy";
import type { BridgeMessageHandler } from "./types";

export const handleError: BridgeMessageHandler = (data, ctx) => {
  const message = (data.message as string) ?? "unknown error";
  const tabId = (data.tabId as string | undefined) ?? "default";
  ctx.activeResponseIdRef.current = null;
  ctx.appendMessage(
    { id: crypto.randomUUID(), role: "agent", text: `Error: ${message}` },
    tabId,
  );
  ctx.updateTab(tabId, (tab) => {
    const closedTools = closeRunningToolCards(tab.messages, {
      notice: "Tool call did not finish before the turn errored.",
    });
    return {
      ...tab,
      waiting: false,
      ...(closedTools.changed ? { messages: closedTools.messages } : {}),
    };
  });
  if (ctx.stateRef.current.activeTabId === tabId) {
    ctx.setStatusFlags({ status: "error" });
  }
};
