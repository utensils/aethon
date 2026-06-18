import { closeRunningToolCards } from "../../utils/agentBusy";
import { emitAgentTurnComplete } from "../../utils/agentTurnEvents";
import { lastAgentText } from "../../utils/messages";
import type { BridgeMessageHandler } from "./types";
import { flushResponseDeltas } from "./responseDelta";

export const handleResponseEnd: BridgeMessageHandler = (data, ctx) => {
  ctx.activeResponseIdRef.current = null;
  const tabId = (data.tabId as string | undefined) ?? "default";
  flushResponseDeltas(tabId);
  // Always clear waiting on response_end. The queue is now held client
  // side: `useQueuedDispatch` watches the `waiting` transition and
  // re-flips it to true while popping the head and dispatching the
  // next message — same render commit, so the Send button doesn't
  // flash. When the queue is empty, waiting stays false.
  // `updateTab` runs its mutator synchronously against the store, so the
  // final reply text is captured here (deltas were just flushed) and
  // broadcast below for speak-agent-replies / conversation mode.
  let finalAgentText = "";
  ctx.updateTab(tabId, (tab) => {
    finalAgentText = lastAgentText(tab.messages);
    const closedTools = closeRunningToolCards(tab.messages);
    return {
      ...tab,
      waiting: false,
      ...(closedTools.changed ? { messages: closedTools.messages } : {}),
    };
  });
  emitAgentTurnComplete({ tabId, text: finalAgentText });
  // Drop the tab from the bucket-independent running set (see promptStarted).
  ctx.setState((prev) => {
    const running = prev.agentRunningTabs as Record<string, true> | undefined;
    const nextRunning = running ? { ...running } : {};
    const wasRunning = nextRunning[tabId] === true;
    if (wasRunning) delete nextRunning[tabId];
    const attention =
      (prev.agentAttentionTabs as Record<string, true> | undefined) ?? {};
    const windowFocused =
      typeof document !== "undefined" && document.hasFocus();
    const shouldMarkAttention =
      prev.activeTabId !== tabId || windowFocused === false;
    const hadAttention = attention[tabId] === true;
    const nextAttention = shouldMarkAttention
      ? hadAttention
        ? attention
        : { ...attention, [tabId]: true }
      : hadAttention
        ? (() => {
            const copy = { ...attention };
            delete copy[tabId];
            return copy;
          })()
        : attention;
    if (!wasRunning && attention === nextAttention) {
      return prev;
    }
    return {
      ...prev,
      agentRunningTabs: nextRunning,
      agentAttentionTabs: nextAttention,
    };
  });
  if (ctx.stateRef.current.activeTabId === tabId) {
    ctx.setState((prev) => ({ ...prev, status: "ready" }));
  }
  // Clear the hang-warn timer and dismiss this tab's notification (if it
  // appeared). Per-tab id so an unrelated tab's response_end doesn't
  // dismiss a still-hung tab's warning.
  {
    const h = ctx.hangWarnTimersRef.current.get(tabId);
    if (h !== undefined) {
      clearTimeout(h);
      ctx.hangWarnTimersRef.current.delete(tabId);
    }
    if (ctx.hangWarnActiveRef.current.delete(tabId)) {
      ctx.dismissNotification(ctx.hangWarnNotifId(tabId));
    }
  }
  // Fire native OS notification when an agent turn completes while the
  // window is unfocused (or the originating tab isn't active). Only for
  // "real" turns (≥ notifyMinDurationSeconds) and only if the user hasn't
  // disabled via [ui] notify_on_completion.
  const startedAt = ctx.turnStartedAtRef.current.get(tabId);
  ctx.turnStartedAtRef.current.delete(tabId);
  if (startedAt !== undefined) {
    const turnDurationMs = Date.now() - startedAt;
    void ctx.maybeFireCompletionNotification({ tabId, turnDurationMs });
  }
};
