import type { QueuedMessage, Tab } from "../types/tab";
import type { ChatAttachment } from "../types/a2ui";
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
  if (eventType === "mode:toggle-plan") {
    const tabId = ctx.stateRef.current.activeTabId as string | undefined;
    const tabs = (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeTab = tabs.find((tab) => tab.id === tabId);
    const enabled =
      activeTab?.kind === "agent" ? activeTab.planMode !== true : true;
    ctx.updateActiveTab((tab) => {
      if (tab.kind !== "agent") return tab;
      return { ...tab, planMode: enabled };
    });
    ctx.setState((prev) => ({ ...prev, planMode: enabled }));
    ctx.pushNotification({
      title: enabled ? "Plan mode on" : "Implementation mode on",
      message: enabled
        ? "New prompts will ask for a plan before code changes."
        : "New prompts may make code changes.",
      kind: "success",
    });
    return true;
  }
  if (eventType === "submit") {
    const payload =
      (data as
        | { value?: string; attachments?: unknown }
        | undefined) ?? {};
    const value = payload.value ?? "";
    const attachments = Array.isArray(payload.attachments)
      ? (payload.attachments as ChatAttachment[])
      : [];
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
    await ctx.sendChat(value, {
      mode,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    return true;
  }
  if (eventType === "attachments:add") {
    const attachments: ChatAttachment[] = Array.isArray(
      (data as { attachments?: unknown } | undefined)?.attachments,
    )
      ? ((data as { attachments: ChatAttachment[] }).attachments)
      : [];
    if (attachments.length > 0) {
      ctx.updateActiveTab((tab) => ({
        ...tab,
        draftAttachments: [...(tab.draftAttachments ?? []), ...attachments],
      }));
    }
    return true;
  }
  if (eventType === "attachment:remove") {
    const id = (data as { id?: string } | undefined)?.id;
    if (id) {
      ctx.updateActiveTab((tab) => ({
        ...tab,
        draftAttachments: (tab.draftAttachments ?? []).filter((a) => a.id !== id),
      }));
    }
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
  if (eventType === "voice:auto-listen") {
    const value = (data as { value?: unknown } | undefined)?.value === true;
    // Live-apply so the running conversation picks it up immediately (the
    // hook reads /voice/conversationContinuous), and persist so the choice
    // sticks — same config key the Settings panel writes.
    ctx.setState((prev) => ({
      ...prev,
      voice: {
        ...(prev.voice ?? {}),
        conversationContinuous: value,
      },
    }));
    ctx.applySettingsPatch({ voice: { conversationContinuous: value } });
    return true;
  }
  return false;
};
