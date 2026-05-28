import type { Tab } from "../types/tab";
import type { EventRouteHandler } from "./types";

/**
 * `queued-messages-popover` events. The composite lives inside the
 * composer and emits four event types (prefixed with `queue:` so they
 * are routable when the popover is mounted inline inside another
 * composite — events route by host component type, not by the
 * popover's own identity in that case):
 *
 *   - `queue:edit`   { messageId, content }  — replace a queued message body.
 *   - `queue:delete` { messageId }           — drop a queued message.
 *   - `queue:steer`  { messageId }           — pop + promote to mid-turn steer.
 *   - `queue:clear`                          — empty the queue.
 *
 * Routes to the active tab's queue (the popover only renders for the
 * active tab, so we never need an explicit tabId in the payload). The
 * handler is registered under BOTH `type:chat-input` (where it lands
 * when the default-layout host inlines the popover) AND
 * `type:queued-messages-popover` (for extension-override mounts that
 * synthesize a fresh A2UI subtree via RegistryComponent).
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
  // Only match queue-namespaced events. The handler is registered
  // under `type:chat-input` (alongside handleChatInput) so it gets
  // first crack at events from the inlined popover; non-queue
  // events fall through to handleChatInput.
  if (!eventType.startsWith("queue:")) return false;
  const tab = activeAgentTab(ctx.stateRef.current);
  if (!tab) return false;
  const tabId = tab.id;
  const action = eventType.slice("queue:".length);

  if (action === "edit") {
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

  if (action === "delete") {
    const payload = (data ?? {}) as { messageId?: string };
    if (typeof payload.messageId === "string") {
      ctx.deleteQueuedMessage(tabId, payload.messageId);
      return true;
    }
    return false;
  }

  if (action === "steer") {
    const payload = (data ?? {}) as { messageId?: string };
    if (typeof payload.messageId === "string") {
      await ctx.steerQueuedMessage(tabId, payload.messageId);
      return true;
    }
    return false;
  }

  if (action === "clear") {
    ctx.clearQueuedMessages(tabId);
    return true;
  }

  return false;
};
