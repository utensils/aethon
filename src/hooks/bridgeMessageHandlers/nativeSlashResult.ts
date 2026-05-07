import type { BridgeMessageHandler } from "./types";

export const handleNativeSlashResult: BridgeMessageHandler = (data, ctx) => {
  const message = (data.message as string | undefined) ?? "";
  if (!message) return;
  const tabId = (data.tabId as string | undefined) ?? "default";
  const kind = data.kind === "error" ? "error" : "info";
  const chatMessage = { id: crypto.randomUUID(), role: "system" as const, text: message };
  ctx.appendMessage(chatMessage, tabId);
  ctx.persistLocalChatMessage(chatMessage, tabId);
  if (kind === "error") {
    const command = (data.command as string | undefined) ?? "command";
    ctx.pushNotification({
      title: `/${command} failed`,
      message,
      kind: "error",
    });
  }
};
