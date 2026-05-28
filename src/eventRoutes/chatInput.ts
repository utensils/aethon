import type { QueuedMessage, Tab } from "../types/tab";
import type { EventRouteHandler } from "./types";

function newestQueuedMessage(
  state: Record<string, unknown>,
): { tabId: string; message: QueuedMessage } | null {
  const tabId = state.activeTabId as string | undefined;
  if (!tabId) return null;
  const tabs = (state.tabs as Tab[] | undefined) ?? [];
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || tab.kind !== "agent") return null;
  const message = (tab.queuedMessages ?? []).at(-1);
  return message ? { tabId, message } : null;
}

/** chat-input: submit forwards to native sendChat (replacing the
 *  bridge round-trip), change persists the unsent draft into the
 *  active tab record, cancel maps to stopPrompt.
 *
 *  Routed by `type:chat-input` so a registry override (or a layout
 *  payload that renames the composer instance) still routes events. */
export const handleChatInput: EventRouteHandler = async (
  { eventType, data },
  ctx,
) => {
  if (eventType === "submit") {
    const value = (data as { value?: string } | undefined)?.value ?? "";
    const mode =
      (data as { mode?: unknown } | undefined)?.mode === "steer"
        ? "steer"
        : "normal";
    if (mode === "steer" && value.trim().length === 0) {
      const queued = newestQueuedMessage(ctx.stateRef.current);
      if (queued) {
        await ctx.steerQueuedMessage(queued.tabId, queued.message.id);
      }
      return true;
    }
    await ctx.sendChat(value, { mode });
    return true;
  }
  if (eventType === "change") {
    // The renderer's optimistic update already wrote /draft (the
    // active-tab mirror); also write into the active tab record so an
    // unsent draft survives a tab switch and isn't clobbered when the
    // tab is re-mirrored to root on switch-back.
    const value = (data as { value?: string } | undefined)?.value ?? "";
    ctx.updateActiveTab((tab) => ({ ...tab, draft: value }));
    return true;
  }
  if (eventType === "cancel") {
    await ctx.stopPrompt();
    return true;
  }
  if (eventType === "voice:setup") {
    const providerId =
      (data as { providerId?: string | null } | undefined)?.providerId ?? null;
    ctx.setState((prev) => ({
      ...prev,
      settings: {
        open: true,
        pending: null,
        focusSection: "voice",
        focusProviderId: providerId,
      },
    }));
    return true;
  }
  return false;
};
