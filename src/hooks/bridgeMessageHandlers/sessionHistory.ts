import { coerceChatMessages } from "../../utils/messages";
import type { BridgeMessageHandler } from "./types";

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
    ...(label ? { label } : {}),
  }));
  ctx.syncRecentSessionsToState();
};
