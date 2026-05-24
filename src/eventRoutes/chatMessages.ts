import type { EventRouteHandler } from "./types";

export const handleChatMessages: EventRouteHandler = async (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "retry") return false;
  const record = data && typeof data === "object" ? data : {};
  const value =
    typeof (record as { value?: unknown }).value === "string"
      ? (record as { value: string }).value
      : "";
  const messageId =
    typeof (record as { messageId?: unknown }).messageId === "string"
      ? (record as { messageId: string }).messageId
      : "";
  if (!value.trim()) return true;
  if (messageId) {
    ctx.updateActiveTab((tab) => ({
      ...tab,
      messages: tab.messages.filter((message) => message.id !== messageId),
    }));
  }
  await ctx.sendChat(value, { mode: "normal" });
  return true;
};
