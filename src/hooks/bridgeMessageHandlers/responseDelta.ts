import type { BridgeMessageHandler } from "./types";
import type { BridgeMessageContext } from "./types";

interface PendingDelta {
  ctx: BridgeMessageContext;
  tabId: string;
  messageId?: string;
  channel: "text" | "thinking";
  content: string;
  model?: string;
}

const pending = new Map<string, PendingDelta>();
let flushScheduled = false;

function keyFor(
  tabId: string,
  messageId: string | undefined,
  channel: "text" | "thinking",
): string {
  return `${tabId}\u0000${messageId ?? ""}\u0000${channel}`;
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  const flush = () => flushResponseDeltas();
  if (typeof window !== "undefined" && "requestAnimationFrame" in window) {
    window.requestAnimationFrame(flush);
  } else {
    setTimeout(flush, 16);
  }
}

export function flushResponseDeltas(tabId?: string): void {
  flushScheduled = false;
  for (const [key, item] of [...pending]) {
    if (tabId && item.tabId !== tabId) continue;
    pending.delete(key);
    item.ctx.appendOrAmendAgentText(
      item.content,
      item.messageId,
      item.tabId,
      item.channel,
      item.model,
    );
  }
  if (pending.size > 0) scheduleFlush();
}

export const handleResponseDelta: BridgeMessageHandler = (data, ctx) => {
  const delta = (data.content as string) ?? "";
  if (!delta) return;
  const messageId = (data.messageId as string) || undefined;
  const tabId = (data.tabId as string | undefined) ?? "default";
  const channel = data.channel === "thinking" ? "thinking" : "text";
  const model =
    typeof data.model === "string" && data.model.length > 0
      ? data.model
      : undefined;
  const key = keyFor(tabId, messageId, channel);
  const existing = pending.get(key);
  if (existing) {
    existing.content += delta;
    existing.ctx = ctx;
    if (model) existing.model = model;
  } else {
    pending.set(key, {
      ctx,
      tabId,
      messageId,
      channel,
      content: delta,
      ...(model ? { model } : {}),
    });
  }
  scheduleFlush();
};
