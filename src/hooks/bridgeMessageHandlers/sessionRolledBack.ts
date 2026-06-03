import type { BridgeMessageHandler } from "./types";
import { truncateToEntry } from "../../utils/messages";

/**
 * Authoritative reconcile after the bridge branched the session. The event
 * route already truncated optimistically; this lands the same truncation
 * keyed off the bridge's confirmed entry id (idempotent — truncating an
 * already-truncated transcript is a no-op) and clears the turn UI.
 */
export const handleSessionRolledBack: BridgeMessageHandler = (data, ctx) => {
  const tabId = typeof data.tabId === "string" ? data.tabId : "default";
  const entryId = typeof data.entryId === "string" ? data.entryId : "";
  if (!entryId) return;
  ctx.updateTab(tabId, (tab) => {
    const messages = truncateToEntry(tab.messages, entryId);
    if (messages === tab.messages && !tab.waiting) return tab;
    return { ...tab, messages, waiting: false, queueCount: 0 };
  });
};
