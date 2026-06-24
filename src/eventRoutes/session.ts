import type { EventRouteHandler } from "./types";
import { truncateToEntry } from "../utils/messages";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Rollback / fork affordances fired from a transcript row (the per-message
 * hover toolbar in the chat-history / main-canvas surfaces).
 *
 *  - `rollback-to-here`: optimistically truncate the rendered transcript to the
 *    chosen message, then ask the bridge to branch the session there. The
 *    bridge's `session_rolled_back` reply reconciles authoritatively.
 *  - `fork-to-tab`: ask the bridge to extract the branch into a new session;
 *    the bridge's `session_forked` reply copies the file + opens the new tab.
 *
 * Both are keyed off `entryId` (the pi session entry id carried on the row).
 */
export const handleSessionBranch: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  const record =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const entryId = str(record.entryId);
  const explicitTabId = str(record.tabId);
  const targetTabId = () =>
    explicitTabId || str(ctx.stateRef.current.activeTabId);

  if (eventType === "rollback-to-here") {
    if (!entryId) return false;
    const tabId = targetTabId();
    if (!tabId) return false;
    ctx.updateTab(tabId, (tab) => {
      const messages = truncateToEntry(tab.messages, entryId);
      return messages === tab.messages
        ? tab
        : { ...tab, messages, waiting: false };
    });
    void ctx.invoke("agent_command", {
      payload: JSON.stringify({ type: "rollback_session", tabId, entryId }),
    });
    return true;
  }

  if (eventType === "fork-to-tab") {
    if (!entryId) return false;
    const tabId = targetTabId();
    if (!tabId) return false;
    void ctx.invoke("agent_command", {
      payload: JSON.stringify({ type: "fork_session", tabId, entryId }),
    });
    return true;
  }

  return false;
};
