import { closeRunningToolCards } from "../../utils/agentBusy";
import { clearPendingForksForTab } from "../../eventRoutes/session";
import { resolveControlWait } from "../controlWaitRegistry";
import { clearAgentActivity } from "./agentActivity";
import { clearHangWarn } from "./hangWarn";
import type { BridgeMessageHandler } from "./types";

export const handleError: BridgeMessageHandler = (data, ctx) => {
  const message = (data.message as string) ?? "unknown error";
  const tabId = (data.tabId as string | undefined) ?? "default";
  if (message.startsWith("fork_session:")) {
    clearPendingForksForTab(tabId);
    ctx.dismissNotification(`session-fork-${tabId}`);
    ctx.pushNotification({
      title: "Fork failed",
      message: message.replace(/^fork_session:\s*/, ""),
      kind: "error",
      durationMs: 6000,
    });
  } else if (message.startsWith("rollback_session:")) {
    ctx.pushNotification({
      title: "Rollback failed",
      message: message.replace(/^rollback_session:\s*/, ""),
      kind: "error",
      durationMs: 6000,
    });
  }
  // A control-dispatched turn that errors must unblock its `--wait` caller too,
  // surfacing the failure rather than hanging until the timeout.
  if (typeof data.controlRequestId === "string" && data.controlRequestId) {
    resolveControlWait(data.controlRequestId, "error", tabId, message);
  }
  ctx.activeResponseIdRef.current = null;
  clearAgentActivity(ctx, tabId);
  ctx.appendMessage(
    {
      id: crypto.randomUUID(),
      role: "agent",
      text: `Error: ${message}`,
      createdAt: Date.now(),
    },
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
  ctx.setState((prev) => {
    const running = prev.agentRunningTabs as Record<string, true> | undefined;
    if (!running || !running[tabId]) return prev;
    const next = { ...running };
    delete next[tabId];
    return { ...prev, agentRunningTabs: next };
  });
  if (ctx.stateRef.current.activeTabId === tabId) {
    ctx.setStatusFlags({ status: "error" });
  }
  clearHangWarn(ctx, tabId);
};
