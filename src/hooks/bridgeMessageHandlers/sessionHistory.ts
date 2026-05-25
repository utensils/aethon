import { coerceChatMessages } from "../../utils/messages";
import type { ChatMessage } from "../../types/a2ui";
import type { BridgeMessageHandler } from "./types";

function firstUserMessageLabel(messages: ChatMessage[]): string | undefined {
  const first = messages.find(
    (m) =>
      m.role === "user" &&
      typeof m.text === "string" &&
      m.text.trim().length > 0,
  );
  const text = first?.text?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 48 ? `${text.slice(0, 47)}...` : text;
}

function shouldReplaceGenericLabel(label: string): boolean {
  return /^Tab \d+$/.test(label) || /^Session [A-Za-z0-9-]+$/.test(label);
}

function mergePendingLocalPrompts(
  restored: ChatMessage[],
  current: ChatMessage[],
): ChatMessage[] {
  // Carry pending local messages — both the optimistic user prompts
  // the user sent before the restored history arrived AND any
  // assistant streaming deltas already in flight — across the
  // history hydration so the transcript stays chronological and
  // live output isn't dropped. Restored transcript first, pending
  // local appended after.
  const restoredIds = new Set(restored.map((m) => m.id));
  const restoredUserTexts = new Set(
    restored
      .filter((m) => m.role === "user" && typeof m.text === "string")
      .map((m) => m.text?.trim())
      .filter(Boolean),
  );
  const pendingLocal = current.filter((m) => {
    if (restoredIds.has(m.id)) return false;
    if (m.role === "user") {
      // A failed local user message is informational once history
      // catches up — the bridge will resend or the user will retry.
      if (!m.delivery || m.delivery === "failed") return false;
      const text = typeof m.text === "string" ? m.text.trim() : "";
      // If the same prompt text already appears in the restored
      // transcript, treat the local copy as a duplicate (the bridge
      // recorded it canonically); otherwise keep it.
      return text.length > 0 && !restoredUserTexts.has(text);
    }
    // Keep system + agent messages that don't share an id with
    // anything in the restored set — those are typically streaming
    // assistant deltas, system notices about the in-flight turn, or
    // tool-card payloads the bridge will resolve as the response
    // continues. Dropping them would erase visible progress the
    // user just watched land.
    return true;
  });
  return pendingLocal.length > 0 ? [...restored, ...pendingLocal] : restored;
}

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
    messages: mergePendingLocalPrompts(messages, tab.messages),
    ...(label
      ? { label }
      : shouldReplaceGenericLabel(tab.label)
        ? { label: firstUserMessageLabel(messages) ?? tab.label }
        : {}),
  }));
  ctx.syncRecentSessionsToState();
};
