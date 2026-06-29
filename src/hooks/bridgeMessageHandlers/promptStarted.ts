import { markControlTurnStarted } from "../controlWaitRegistry";
import type { BridgeMessageHandler } from "./types";
import { clearAgentActivity } from "./agentActivity";
import { armHangWarn } from "./hangWarn";

/** Bridge tells us a prompt has begun. Sent for handler-driven
 *  ctx.pi.prompt AND every queue-drained turn (source: "queue") so Stop
 *  stays visible across followUp boundaries instead of flashing back to
 *  Send between turns. The remaining queue count rides along so the
 *  input badge stays accurate. tabId routes status to one tab; status
 *  bar text only flips for the active tab. */
export const handlePromptStarted: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  // A control-dispatched send that produced a real turn echoes its id here.
  // The wait fallback uses this to tell a genuine turn apart from a locally
  // handled slash command (which never reaches the bridge).
  if (typeof data.controlRequestId === "string" && data.controlRequestId) {
    markControlTurnStarted(data.controlRequestId);
  }
  // Record turn start so response_end can compute duration and decide
  // whether to fire the OS completion notification.
  ctx.turnStartedAtRef.current.set(tabId, Date.now());
  clearAgentActivity(ctx, tabId);
  ctx.updateTab(tabId, (tab) => {
    // queueCount mirrors the CLIENT-held queue now (Claudette-style
    // queued-messages popover). The bridge's `data.queued` field came
    // from pi's followUp queue and is stale on the new flow — frontend
    // never invokes send_message during a busy turn, so pi's queue
    // stays empty and overwriting with that 0 would erase items the
    // user just popped off the client queue. Recompute from
    // `queuedMessages.length` instead so the badge stays in lockstep
    // with the popover.
    const next = {
      ...tab,
      waiting: true,
      queueCount: (tab.queuedMessages ?? []).length,
    };
    if (data.source !== "queue") return next;
    let promoted = false;
    return {
      ...next,
      messages: next.messages.map((message) => {
        if (
          promoted ||
          message.role !== "user" ||
          message.delivery !== "queued"
        ) {
          return message;
        }
        promoted = true;
        return { ...message, delivery: "sent" as const };
      }),
    };
  });
  // Track the in-flight turn in a bucket-independent running set. Unlike
  // `tab.waiting` (only mirrored into `state.tabs`, i.e. the active
  // workspace), this set spans every workspace so the sidebar's
  // agent-activity dots stay accurate for backgrounded projects/workspaces.
  ctx.setState((prev) => {
    const running =
      (prev.agentRunningTabs as Record<string, true> | undefined) ?? {};
    const attention =
      (prev.agentAttentionTabs as Record<string, true> | undefined) ?? {};
    const result: Record<string, unknown> = running[tabId]
      ? prev
      : { ...prev, agentRunningTabs: { ...running, [tabId]: true } };
    if (!attention[tabId]) return result;
    const nextAttention = { ...attention };
    delete nextAttention[tabId];
    return { ...result, agentAttentionTabs: nextAttention };
  });
  if (ctx.stateRef.current.activeTabId === tabId) {
    ctx.setState((prev) => ({ ...prev, status: "thinking…" }));
  }
  // Start the silence watchdog. Progress events refresh this timer, so the
  // warning means "no agent activity lately" rather than "long healthy turn".
  armHangWarn(ctx, tabId);
};
