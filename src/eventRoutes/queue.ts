import type { Tab } from "../types/tab";
import type { EventRouteHandler } from "./types";

/**
 * `queued-messages-popover` events. The composite lives inside the
 * composer and emits four event types:
 *
 *   - `edit`   { messageId, content }  — replace a queued message body.
 *   - `delete` { messageId }           — drop a queued message.
 *   - `steer`  { messageId }           — pop + promote to mid-turn steer.
 *   - `clear`                          — empty the queue.
 *
 * Routes to the active tab's queue (the popover only renders for the
 * active tab, so we never need an explicit tabId in the payload). Keyed
 * by `type:queued-messages-popover` so a custom override registered via
 * `aethon.registerComponent("queued-messages-popover", …)` still routes
 * through these handlers without an alias entry.
 */
function activeTabId(state: Record<string, unknown>): string | undefined {
  return state.activeTabId as string | undefined;
}

function activeAgentTab(state: Record<string, unknown>): Tab | undefined {
  const id = activeTabId(state);
  if (!id) return undefined;
  const tabs = (state.tabs as Tab[] | undefined) ?? [];
  const tab = tabs.find((t) => t.id === id);
  return tab && tab.kind === "agent" ? tab : undefined;
}

export const handleQueuedMessages: EventRouteHandler = async (
  { eventType, data },
  ctx,
) => {
  const tab = activeAgentTab(ctx.stateRef.current);
  if (!tab) return false;
  const tabId = tab.id;

  if (eventType === "edit") {
    const payload = (data ?? {}) as { messageId?: string; content?: string };
    if (
      typeof payload.messageId === "string" &&
      typeof payload.content === "string"
    ) {
      ctx.editQueuedMessage(tabId, payload.messageId, payload.content);
      return true;
    }
    return false;
  }

  if (eventType === "delete") {
    const payload = (data ?? {}) as { messageId?: string };
    if (typeof payload.messageId === "string") {
      ctx.deleteQueuedMessage(tabId, payload.messageId);
      return true;
    }
    return false;
  }

  if (eventType === "steer") {
    const payload = (data ?? {}) as { messageId?: string };
    if (typeof payload.messageId === "string") {
      await ctx.steerQueuedMessage(tabId, payload.messageId);
      return true;
    }
    return false;
  }

  if (eventType === "clear") {
    ctx.clearQueuedMessages(tabId);
    return true;
  }

  return false;
};
