import type { EventRouteHandler } from "./types";

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
  return false;
};
