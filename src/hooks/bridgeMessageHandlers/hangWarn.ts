import type { Tab } from "../../types/tab";
import type { BridgeMessage, BridgeMessageContext } from "./types";

function shortPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
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
  const bits = ["This session has not shown activity for a while."];
  if (cwd) bits.push(`Working directory: ${cwd}.`);
  if (tab.queueCount > 0) {
    bits.push(
      `${tab.queueCount} queued message${tab.queueCount === 1 ? "" : "s"} waiting.`,
    );
  }
  return bits.join(" ");
}

function tabById(ctx: BridgeMessageContext, tabId: string): Tab | undefined {
  const tabs = (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
  return tabs.find((t) => t.id === tabId);
}

export function clearHangWarn(ctx: BridgeMessageContext, tabId: string): void {
  const handle = ctx.hangWarnTimersRef.current.get(tabId);
  if (handle !== undefined) {
    clearTimeout(handle);
    ctx.hangWarnTimersRef.current.delete(tabId);
  }
  if (ctx.hangWarnActiveRef.current.delete(tabId)) {
    ctx.dismissNotification(ctx.hangWarnNotifId(tabId));
  }
}

export function armHangWarn(ctx: BridgeMessageContext, tabId: string): void {
  const prev = ctx.hangWarnTimersRef.current.get(tabId);
  if (prev !== undefined) clearTimeout(prev);
  const handle = setTimeout(() => {
    ctx.hangWarnTimersRef.current.delete(tabId);
    const cur = ctx.stateRef.current;
    if ((cur.activeTabId as string | undefined) !== tabId) return;
    const tab = tabById(ctx, tabId);
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

export function refreshHangWarn(
  ctx: BridgeMessageContext,
  tabId: string,
): void {
  const hasTimer = ctx.hangWarnTimersRef.current.has(tabId);
  const wasActive = ctx.hangWarnActiveRef.current.has(tabId);
  if (!hasTimer && !wasActive) return;

  const tab = tabById(ctx, tabId);
  if (!tab?.waiting) {
    clearHangWarn(ctx, tabId);
    return;
  }

  if (wasActive) {
    ctx.hangWarnActiveRef.current.delete(tabId);
    ctx.dismissNotification(ctx.hangWarnNotifId(tabId));
  }
  armHangWarn(ctx, tabId);
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

export function bridgeMessageRefreshesHangWarn(
  message: BridgeMessage,
): boolean {
  switch (message.type) {
    case "response_delta":
      return hasText(message.content);
    case "terminal_output":
      return hasText(message.content);
    case "response":
      return hasText(message.content);
    case "a2ui":
    case "subagent_progress":
      return true;
    case "notice":
      return message.busy === true;
    default:
      return false;
  }
}

export function refreshHangWarnForBridgeMessage(
  message: BridgeMessage,
  ctx: BridgeMessageContext,
): void {
  if (!bridgeMessageRefreshesHangWarn(message)) return;
  refreshHangWarn(ctx, (message.tabId as string | undefined) ?? "default");
}
