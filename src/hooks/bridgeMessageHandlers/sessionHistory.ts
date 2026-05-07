import { coerceChatMessages } from "../../utils/messages";
import type { ChatMessage } from "../../types/a2ui";
import type { BridgeMessageHandler } from "./types";

function firstUserMessageLabel(messages: ChatMessage[]): string | undefined {
  const first = messages.find(
    (m) =>
      m.role === "user" &&
      typeof m.text === "string" &&
      m.text.trim().length > 0,
  );
  const text = first?.text?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 48 ? `${text.slice(0, 47)}...` : text;
}

function shouldReplaceGenericLabel(label: string): boolean {
  return /^Tab \d+$/.test(label) || /^Session [A-Za-z0-9-]+$/.test(label);
}

export const handleSessionHistory: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  const messages = coerceChatMessages(data.messages);
  const session = ctx.allDiscoveredSessionsRef.current.find(
    (s) => s.tabId === tabId,
  );
  const label =
    session?.customLabel ??
    (session?.firstUserMessage
      ? session.firstUserMessage.replace(/\s+/g, " ").trim()
      : undefined);
  ctx.updateTab(tabId, (tab) => ({
    ...tab,
    messages,
    ...(label
      ? { label }
      : shouldReplaceGenericLabel(tab.label)
        ? { label: firstUserMessageLabel(messages) ?? tab.label }
        : {}),
  }));
  ctx.syncRecentSessionsToState();
};
