import { coerceChatMessages } from "../../utils/messages";
import type { BridgeMessageHandler } from "./types";

export const handleSessionHistory: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  const messages = coerceChatMessages(data.messages);
  ctx.updateTab(tabId, (tab) => ({ ...tab, messages }));
  ctx.syncRecentSessionsToState();
};
