import type { BridgeMessageHandler } from "./types";

export const handleResponseDelta: BridgeMessageHandler = (data, ctx) => {
  const delta = (data.content as string) ?? "";
  if (!delta) return;
  const messageId = (data.messageId as string) || undefined;
  const tabId = (data.tabId as string | undefined) ?? "default";
  const channel = data.channel === "thinking" ? "thinking" : "text";
  ctx.appendOrAmendAgentText(delta, messageId, tabId, channel);
};
