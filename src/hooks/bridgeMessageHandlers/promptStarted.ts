import type { Tab } from "../../types/tab";
import type { BridgeMessageHandler } from "./types";

function shortPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join("/")}`;
}

function hangWarnTitle(tab: Tab): string {
  const label = tab.label?.trim() || "Agent session";
  const model = tab.model?.trim();
  return model
    ? `${label} is still working (${model})`
    : `${label} is still working`;
}

function hangWarnMessage(tab: Tab): string {
  const cwd = shortPath(tab.cwd);
  const bits = ["This session has been running longer than expected."];
  if (cwd) bits.push(`Working directory: ${cwd}.`);
  if (tab.queueCount > 0) {
    bits.push(
      `${tab.queueCount} queued message${tab.queueCount === 1 ? "" : "s"} waiting.`,
    );
  }
  return bits.join(" ");
}

/** Bridge tells us a prompt has begun. Sent for handler-driven
 *  ctx.pi.prompt AND every queue-drained turn (source: "queue") so Stop
 *  stays visible across followUp boundaries instead of flashing back to
 *  Send between turns. The remaining queue count rides along so the
 *  input badge stays accurate. tabId routes status to one tab; status
 *  bar text only flips for the active tab. */
export const handlePromptStarted: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  // Record turn start so response_end can compute duration and decide
  // whether to fire the OS completion notification.
  ctx.turnStartedAtRef.current.set(tabId, Date.now());
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
  // Start hang-warn timer. Reset if a queue-drained prompt_started fires
  // for the same tab (the 30s clock restarts on each new turn).
  {
    const prev = ctx.hangWarnTimersRef.current.get(tabId);
    if (prev !== undefined) clearTimeout(prev);
    const handle = setTimeout(() => {
      ctx.hangWarnTimersRef.current.delete(tabId);
      const cur = ctx.stateRef.current;
      if ((cur.activeTabId as string | undefined) !== tabId) return;
      const tabs = (cur.tabs as Tab[] | undefined) ?? [];
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab?.waiting) return;
      ctx.hangWarnActiveRef.current.add(tabId);
      ctx.pushNotification({
        id: ctx.hangWarnNotifId(tabId),
        title: hangWarnTitle(tab),
        message: hangWarnMessage(tab),
        kind: "warning",
        durationMs: null,
        actions: [
          { label: "Open session", action: `activate-tab:${tabId}` },
          { label: "Stop", action: `hang-warn:stop:${tabId}` },
          { label: "Force restart", action: "hang-warn:force-restart" },
        ],
      });
    }, ctx.hangWarnMs);
    ctx.hangWarnTimersRef.current.set(tabId, handle);
  }
};
