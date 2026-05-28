import {
  coerceChatMessages,
  dedupeToolResultTextMessages,
} from "../../utils/messages";
import { toolCardIdentityFromId } from "../../utils/toolCardIdentity";
import type { A2UIComponent, ChatMessage } from "../../types/a2ui";
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

function toolCardComponents(message: ChatMessage): A2UIComponent[] {
  return (message.a2ui?.components ?? []).filter(
    (component): component is A2UIComponent =>
      component?.type === "tool-card" && typeof component.id === "string",
  );
}

function toolCardIdentity(component: A2UIComponent): string | undefined {
  return toolCardIdentityFromId(component.id);
}

function completedRestoredToolIdentities(restored: ChatMessage[]): Set<string> {
  const identities = new Set<string>();
  for (const message of restored) {
    for (const component of toolCardComponents(message)) {
      const identity = toolCardIdentity(component);
      if (
        identity &&
        component.props?.startedAt !== undefined &&
        component.props.endedAt !== undefined
      ) {
        identities.add(identity);
      }
    }
  }
  return identities;
}

function isDuplicateCompletedToolCard(
  message: ChatMessage,
  completedTools: ReadonlySet<string>,
): boolean {
  const toolCards = toolCardComponents(message);
  if (toolCards.length === 0) return false;
  return toolCards.every((component) => {
    const identity = toolCardIdentity(component);
    return Boolean(identity && completedTools.has(identity));
  });
}

function isLivePendingMessage(message: ChatMessage): boolean {
  if (message.role === "user") {
    return message.delivery === "sent" || message.delivery === "steered";
  }
  if (message.role !== "agent") return false;
  if (message.text || message.thinking) return true;
  return toolCardComponents(message).some(
    (component) =>
      component.props?.startedAt !== undefined &&
      component.props.endedAt === undefined,
  );
}

function agentContentSignatures(message: ChatMessage): string[] {
  if (message.role !== "agent" || message.a2ui) return [];
  const signatures: string[] = [];
  const text = message.text?.replace(/\s+/g, " ").trim();
  if (text) signatures.push(`text:${text}`);
  const thinking = message.thinking?.replace(/\s+/g, " ").trim();
  if (thinking) signatures.push(`thinking:${thinking}`);
  return signatures;
}

function restoredAgentContentSignatures(restored: ChatMessage[]): Set<string> {
  const signatures = new Set<string>();
  for (const message of restored) {
    for (const signature of agentContentSignatures(message)) {
      signatures.add(signature);
    }
  }
  return signatures;
}

function isDuplicateRestoredAgentContent(
  message: ChatMessage,
  restoredAgentContent: ReadonlySet<string>,
): boolean {
  const signatures = agentContentSignatures(message);
  return (
    signatures.length > 0 &&
    signatures.every((signature) => restoredAgentContent.has(signature))
  );
}

function mergePendingLocalPrompts(
  restored: ChatMessage[],
  current: ChatMessage[],
): { messages: ChatMessage[]; hasLivePending: boolean } {
  // Carry pending local messages — both the optimistic user prompts
  // the user sent before the restored history arrived AND any
  // assistant streaming deltas already in flight — across the
  // history hydration so the transcript stays chronological and
  // live output isn't dropped. Restored transcript first, pending
  // local appended after.
  const restoredIds = new Set(restored.map((m) => m.id));
  const completedTools = completedRestoredToolIdentities(restored);
  const restoredAgentContent = restoredAgentContentSignatures(restored);
  const restoredUserTexts = new Set(
    restored
      .filter((m) => m.role === "user" && typeof m.text === "string")
      .map((m) => m.text?.trim())
      .filter(Boolean),
  );
  const pendingLocal = current.filter((m) => {
    if (restoredIds.has(m.id)) return false;
    if (isDuplicateCompletedToolCard(m, completedTools)) return false;
    if (isDuplicateRestoredAgentContent(m, restoredAgentContent)) return false;
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
  return {
    messages:
      pendingLocal.length > 0 ? [...restored, ...pendingLocal] : restored,
    hasLivePending: pendingLocal.some(isLivePendingMessage),
  };
}

export const handleSessionHistory: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  const messages = dedupeToolResultTextMessages(
    coerceChatMessages(data.messages),
  );
  const session = ctx.allDiscoveredSessionsRef.current.find(
    (s) => s.tabId === tabId,
  );
  const label =
    session?.customLabel ??
    (session?.firstUserMessage
      ? session.firstUserMessage.replace(/\s+/g, " ").trim()
      : undefined);
  ctx.updateTab(tabId, (tab) => {
    const merged = mergePendingLocalPrompts(
      messages,
      dedupeToolResultTextMessages(tab.messages),
    );
    return {
      ...tab,
      messages: dedupeToolResultTextMessages(merged.messages),
      waiting: merged.hasLivePending ? tab.waiting : false,
      ...(label
        ? { label }
        : shouldReplaceGenericLabel(tab.label)
          ? { label: firstUserMessageLabel(messages) ?? tab.label }
          : {}),
    };
  });
  ctx.syncRecentSessionsToState();
};
