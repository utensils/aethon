import type { BridgeMessageHandler } from "./types";

export const handleResponseEnd: BridgeMessageHandler = (data, ctx) => {
  ctx.activeResponseIdRef.current = null;
  const tabId = (data.tabId as string | undefined) ?? "default";
  // Only clear waiting when the queue is actually empty. If pi has a
  // followUp queued, it will fire agent_start → prompt_started
  // immediately after this and re-flip waiting; clearing here would
  // cause a Send-flash.
  ctx.updateTab(tabId, (tab) => {
    if (tab.queueCount > 0) return tab;
    return { ...tab, waiting: false };
  });
  if (ctx.stateRef.current.activeTabId === tabId) {
    ctx.setState((prev) => {
      const q = (prev.queueCount as number) ?? 0;
      if (q > 0) return prev;
      return { ...prev, status: "ready" };
    });
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
