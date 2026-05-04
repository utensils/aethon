import type { EventRouteHandler } from "./types";

/** chat-input: submit forwards to native sendChat (replacing the
 *  bridge round-trip), change persists the unsent draft into the
 *  active tab record, cancel maps to stopPrompt. */
export const handleChatInput: EventRouteHandler = async (
  { component, eventType, data },
  ctx,
) => {
  if (component.id !== "chat-input") return false;
  if (eventType === "submit") {
    const value = (data as { value?: string } | undefined)?.value ?? "";
    await ctx.sendChat(value);
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
  return false;
};
