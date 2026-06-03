import { closeRunningToolCards } from "../../utils/agentBusy";
import {
  coerceChatMessages,
  dedupeToolResultTextMessages,
} from "../../utils/messages";
import { toolCardIdentityFromId } from "../../utils/toolCardIdentity";
import type { A2UIComponent, ChatMessage } from "../../types/a2ui";
import type { Tab } from "../../types/tab";
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

function isLivePendingMessage(
  message: ChatMessage,
  currentlyWaiting: boolean,
  latestRestoredTime: number | undefined,
): boolean {
  if (message.role === "user") {
    return message.delivery === "sent" || message.delivery === "steered";
  }
  if (!currentlyWaiting) return false;
  if (message.role !== "agent") return false;
  const createdAt = messageCreatedAt(message);
  if (
    typeof createdAt === "number" &&
    typeof latestRestoredTime === "number" &&
    createdAt < latestRestoredTime
  ) {
    return false;
  }
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

function stderrMirrorSignature(message: ChatMessage): string | undefined {
  if (message.role !== "system" || typeof message.text !== "string") {
    return undefined;
  }
  const text = message.text.replace(/\s+/g, " ").trim();
  if (!text.startsWith("[agent stderr] ")) return undefined;
  const timestamp =
    typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
      ? String(message.createdAt)
      : "";
  return `stderr:${timestamp}:${text}`;
}

function restoredStderrMirrorSignatures(restored: ChatMessage[]): Set<string> {
  const signatures = new Set<string>();
  for (const message of restored) {
    const signature = stderrMirrorSignature(message);
    if (signature) signatures.add(signature);
  }
  return signatures;
}

function isCompactionMarker(message: ChatMessage): boolean {
  if (message.role !== "system" || typeof message.text !== "string") {
    return false;
  }
  const text = message.text.replace(/\s+/g, " ").trim().toLowerCase();
  return (
    text === "compacting context..." ||
    text === "compacting context…" ||
    text.startsWith("context compacted") ||
    text.startsWith("context compaction complete") ||
    text.startsWith("context compaction failed:")
  );
}

function isStopNotice(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    message.text?.replace(/\s+/g, " ").trim().toLowerCase() ===
      "agent stopped."
  );
}

function restoredCompactionMarkers(restored: ChatMessage[]): ChatMessage[] {
  return restored.filter(
    (message) => message.id.startsWith("compaction:") && isCompactionMarker(message),
  );
}

function isDuplicateCompactionMarker(
  message: ChatMessage,
  restoredCompactions: readonly ChatMessage[],
): boolean {
  if (!isCompactionMarker(message) || restoredCompactions.length === 0) {
    return false;
  }
  if (typeof message.createdAt !== "number") {
    return restoredCompactions.some((candidate) => candidate.text === message.text);
  }
  const createdAt = message.createdAt;
  return restoredCompactions.some(
    (candidate) =>
      typeof candidate.createdAt === "number" &&
      Math.abs(candidate.createdAt - createdAt) <= 5 * 60 * 1000,
  );
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

function messageCreatedAt(message: ChatMessage): number | undefined {
  if (
    typeof message.createdAt === "number" &&
    Number.isFinite(message.createdAt)
  ) {
    return message.createdAt;
  }
  if (message.role !== "system" || typeof message.text !== "string") {
    return undefined;
  }
  const raw = /^\[agent stderr\]\s+(\d{4}-\d{2}-\d{2}T[^\s]+)/.exec(
    message.text,
  )?.[1];
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isStaleUntimestampedSystemNotice(message: ChatMessage): boolean {
  if (isStopNotice(message)) return true;
  if (message.role !== "system" || messageCreatedAt(message) !== undefined) {
    return false;
  }
  const text = message.text?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  return (
    text === "agent stopped." ||
    text === "compacting context..." ||
    text === "compacting context…" ||
    text.startsWith("context compacted") ||
    text.startsWith("context compaction complete") ||
    text.startsWith("context compaction failed:")
  );
}

function mergeTimestampedLocalMessages(
  restored: ChatMessage[],
  local: ChatMessage[],
): ChatMessage[] {
  if (local.length === 0) return restored;
  return [
    ...restored.map((message, order) => ({ message, order })),
    ...local.map((message, offset) => ({
      message,
      order: restored.length + offset,
    })),
  ]
    .sort((a, b) => {
      const aTime = messageCreatedAt(a.message);
      const bTime = messageCreatedAt(b.message);
      if (
        typeof aTime === "number" &&
        typeof bTime === "number" &&
        aTime !== bTime
      ) {
        return aTime - bTime;
      }
      return a.order - b.order;
    })
    .map((entry) => entry.message);
}

function latestMessageTime(messages: ChatMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    const createdAt = messageCreatedAt(message);
    if (createdAt === undefined) continue;
    latest = latest === undefined ? createdAt : Math.max(latest, createdAt);
  }
  return latest;
}

function mergePendingLocalPrompts(
  restored: ChatMessage[],
  current: ChatMessage[],
  currentlyWaiting: boolean,
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
  const restoredStderr = restoredStderrMirrorSignatures(restored);
  const restoredCompactions = restoredCompactionMarkers(restored);
  const latestRestoredTime = latestMessageTime(restored);
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
    const stderrSignature = stderrMirrorSignature(m);
    if (stderrSignature && restoredStderr.has(stderrSignature)) return false;
    if (isDuplicateCompactionMarker(m, restoredCompactions)) return false;
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
    if (
      restored.length > 0 &&
      m.role === "system" &&
      isStaleUntimestampedSystemNotice(m)
    ) {
      return false;
    }
    // Keep system + agent messages that don't share an id with
    // anything in the restored set — those are typically streaming
    // assistant deltas, system notices about the in-flight turn, or
    // tool-card payloads the bridge will resolve as the response
    // continues. Dropping them would erase visible progress the
    // user just watched land.
    return true;
  });
  const timestampedLocal = pendingLocal.filter(
    (message) =>
      !isLivePendingMessage(message, currentlyWaiting, latestRestoredTime) &&
      messageCreatedAt(message) !== undefined,
  );
  const appendLocal = pendingLocal.filter(
    (message) =>
      isLivePendingMessage(message, currentlyWaiting, latestRestoredTime) ||
      messageCreatedAt(message) === undefined,
  );
  const mergedHistory = mergeTimestampedLocalMessages(restored, timestampedLocal);
  return {
    messages:
      appendLocal.length > 0 ? [...mergedHistory, ...appendLocal] : mergedHistory,
    hasLivePending: pendingLocal.some((message) =>
      isLivePendingMessage(message, currentlyWaiting, latestRestoredTime),
    ),
  };
}

export const handleSessionHistory: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  const messages = dedupeToolResultTextMessages(
    coerceChatMessages(data.messages).filter((message) => !isStopNotice(message)),
  );
  const session = ctx.allDiscoveredSessionsRef.current.find(
    (s) => s.tabId === tabId,
  );
  const label =
    session?.customLabel ??
    (session?.firstUserMessage
      ? session.firstUserMessage.replace(/\s+/g, " ").trim()
      : undefined);
  const activeTab =
    ctx.stateRef.current.activeTabId === tabId
      ? ((ctx.stateRef.current.tabs as Tab[] | undefined) ?? []).find(
          (tab) => tab.id === tabId,
        )
      : undefined;
  const activeHydration = activeTab
    ? mergePendingLocalPrompts(
        messages,
        dedupeToolResultTextMessages(activeTab.messages),
        activeTab.waiting === true,
      )
    : undefined;
  ctx.updateTab(tabId, (tab) => {
    const merged = mergePendingLocalPrompts(
      messages,
      dedupeToolResultTextMessages(tab.messages),
      tab.waiting === true,
    );
    const nextWaiting = merged.hasLivePending ? tab.waiting : false;
    const dedupedMessages = dedupeToolResultTextMessages(merged.messages);
    const closedTools = nextWaiting
      ? { messages: dedupedMessages, changed: false }
      : closeRunningToolCards(dedupedMessages, {
          notice:
            "No live prompt is running. This tool was marked stopped after restore.",
        });
    return {
      ...tab,
      messages: closedTools.messages,
      waiting: nextWaiting,
      ...(label
        ? { label }
        : shouldReplaceGenericLabel(tab.label)
          ? { label: firstUserMessageLabel(messages) ?? tab.label }
      : {}),
    };
  });
  if (activeHydration && !activeHydration.hasLivePending) {
    ctx.setStatusFlags({ waiting: false, status: "ready" });
  }
  ctx.syncRecentSessionsToState();
};
