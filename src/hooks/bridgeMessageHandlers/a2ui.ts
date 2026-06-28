import type { A2UIComponent, A2UIPayload, ChatMessage } from "../../types/a2ui";
import type { Tab } from "../../types/tab";
import { closeRunningToolCards } from "../../utils/agentBusy";
import { toolCardIdentityFromId } from "../../utils/toolCardIdentity";
import type { BridgeMessageHandler } from "./types";
import { clearHangWarn } from "./hangWarn";
import { flushResponseDeltas } from "./responseDelta";

function upsertableToolCard(payload: A2UIPayload): A2UIComponent | undefined {
  const toolCards = (payload.components ?? []).filter(
    (component) =>
      component?.type === "tool-card" && typeof component.id === "string",
  );
  if (toolCards.length !== 1) return undefined;
  const component = toolCards[0];
  if (component.props?.startedAt === undefined) return undefined;
  return component;
}

function numericProp(
  component: A2UIComponent,
  key: string,
): number | undefined {
  const value = component.props?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function createdAtFromPayload(payload: A2UIPayload): number | undefined {
  for (const component of payload.components ?? []) {
    if (component?.type !== "tool-card") continue;
    return (
      numericProp(component, "startedAt") ?? numericProp(component, "endedAt")
    );
  }
  return undefined;
}

function isCancelledToolCard(component: A2UIComponent | undefined): boolean {
  return (
    component?.type === "tool-card" && component.props?.status === "cancelled"
  );
}

function messageMatchesToolCardId(
  message: ChatMessage,
  toolCardId: string,
): boolean {
  return (message.a2ui?.components ?? []).some((component) => {
    if (component?.type !== "tool-card") return false;
    if (component.props?.startedAt === undefined) return false;
    return component.id === toolCardId;
  });
}

function componentMatchesIncomingToolId(
  component: A2UIComponent | undefined,
  incomingId: string,
): boolean {
  if (component?.type !== "tool-card") return false;
  if (component.props?.startedAt === undefined) return false;
  return component.id === incomingId;
}

function componentMatchesToolIdentity(
  component: A2UIComponent | undefined,
  identity: string,
  incomingStartedAt: number | undefined,
  incomingEndedAt: number | undefined,
): boolean {
  if (component?.type !== "tool-card") return false;
  const currentStartedAt = numericProp(component, "startedAt");
  if (currentStartedAt === undefined) return false;
  // When both the existing card and the incoming one are still running (no
  // endedAt), a replayed tool_execution_start mints a fresh startedAt for the
  // same logical call (identity == normalized toolCallId, which is unique per
  // call). Merge by identity alone in that case so a retry/respawn doesn't
  // leave two "Running" copies. The strict startedAt match still gates merges
  // that involve a finished card (e.g. late results onto a cancelled card).
  const bothRunning =
    numericProp(component, "endedAt") === undefined &&
    incomingEndedAt === undefined;
  if (
    !bothRunning &&
    incomingStartedAt !== undefined &&
    currentStartedAt !== incomingStartedAt
  ) {
    return false;
  }
  return (
    typeof component.id === "string" &&
    toolCardIdentityFromId(component.id) === identity
  );
}

function findCurrentToolCardMatches(
  messages: ChatMessage[],
  incomingId: string | undefined,
  identity: string | undefined,
  incomingStartedAt: number | undefined,
  incomingEndedAt: number | undefined,
): Array<{ index: number; component: A2UIComponent }> {
  const matches: Array<{ index: number; component: A2UIComponent }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const component = (messages[index].a2ui?.components ?? []).find((item) => {
      if (componentMatchesIncomingToolId(item, incomingId ?? "")) return true;
      if (!identity) return false;
      return componentMatchesToolIdentity(
        item,
        identity,
        incomingStartedAt,
        incomingEndedAt,
      );
    });
    if (component) matches.push({ index, component });
  }
  return matches;
}

function insertChronologically(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  const createdAt = message.createdAt;
  if (typeof createdAt !== "number") return [...messages, message];
  const insertAt = messages.findIndex(
    (current) =>
      typeof current.createdAt === "number" && current.createdAt > createdAt,
  );
  if (insertAt < 0) return [...messages, message];
  const next = [...messages];
  next.splice(insertAt, 0, message);
  return next;
}

function cancellationHistoryNotice(componentId: string): A2UIComponent {
  return {
    id: `${componentId}-late-completion-notice`,
    type: "code",
    props: {
      language: "text",
      content:
        "This tool reported a final result after it had already been marked stopped. Keeping the cancellation state; final output is shown below.",
    },
  };
}

function preserveCancelledToolState(
  payload: A2UIPayload,
  fallbackEndedAt?: number,
): A2UIPayload {
  return {
    ...payload,
    components: (payload.components ?? []).map((component) => {
      if (component?.type !== "tool-card") return component;
      const endedAt = numericProp(component, "endedAt") ?? fallbackEndedAt;
      return {
        ...component,
        props: {
          ...(component.props ?? {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
          status: "cancelled",
        },
        children: [
          cancellationHistoryNotice(component.id),
          ...(component.children ?? []),
        ],
      };
    }),
  };
}

function upsertToolCardMessage(
  current: Tab,
  message: ChatMessage,
  payload: A2UIPayload,
  toolCard: A2UIComponent,
  identity: string | undefined,
): { tab: Tab; message: ChatMessage } {
  const incomingId = toolCard.id;
  const incomingStartedAt = numericProp(toolCard, "startedAt");
  const incomingEndedAt = numericProp(toolCard, "endedAt");
  const matches = findCurrentToolCardMatches(
    current.messages,
    incomingId,
    identity,
    incomingStartedAt,
    incomingEndedAt,
  );
  if (matches.length > 0) {
    const targetIndex = matches[0].index;
    const duplicateIndexes = new Set(
      matches.slice(1).map((match) => match.index),
    );
    const matchedCancelled = matches.some((match) =>
      isCancelledToolCard(match.component),
    );
    const matchedCancelledEndedAt = matches
      .map((match) => numericProp(match.component, "endedAt"))
      .find((value) => value !== undefined);
    const incomingCancelled =
      payload.components?.some(isCancelledToolCard) === true;
    const finalPayload =
      matchedCancelled && !incomingCancelled
        ? preserveCancelledToolState(payload, matchedCancelledEndedAt)
        : payload;
    const finalMessage = { ...message, a2ui: finalPayload };
    const nextMessages = current.messages.flatMap((currentMessage, index) => {
      if (index === targetIndex) return [finalMessage];
      if (duplicateIndexes.has(index)) return [];
      return [currentMessage];
    });
    return {
      tab: { ...current, messages: nextMessages },
      message: finalMessage,
    };
  }

  const sameMessageIndex = current.messages.findIndex(
    (currentMessage) =>
      currentMessage.id === message.id ||
      messageMatchesToolCardId(currentMessage, incomingId),
  );
  if (sameMessageIndex >= 0) {
    const replacedMessages = [...current.messages];
    replacedMessages[sameMessageIndex] = message;
    return { tab: { ...current, messages: replacedMessages }, message };
  }

  return {
    tab: {
      ...current,
      messages: insertChronologically(current.messages, message),
    },
    message,
  };
}

export const handleA2ui: BridgeMessageHandler = (data, ctx) => {
  const payload = data.payload as A2UIPayload | undefined;
  const id = (data.id as string) || crypto.randomUUID();
  const tabId = (data.tabId as string | undefined) ?? "default";
  // Tool cards / A2UI payloads are appended synchronously, while streamed
  // response deltas are frame-batched. Drain this tab's pending deltas first
  // so any pre-tool assistant text/thinking renders before the tool card.
  flushResponseDeltas(tabId);
  if (payload) {
    const createdAt = createdAtFromPayload(payload);
    const toolCard = upsertableToolCard(payload);
    const identity = toolCard ? toolCardIdentityFromId(toolCard.id) : undefined;
    const message: ChatMessage = {
      id,
      role: "agent",
      a2ui: payload,
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
    if (toolCard) {
      let durableMessage = message;
      ctx.updateTab(tabId, (current) => {
        const result = upsertToolCardMessage(
          current,
          message,
          payload,
          toolCard,
          identity,
        );
        durableMessage = result.message;
        return result.tab;
      });
      ctx.persistLocalChatMessage(durableMessage, tabId);
    } else {
      ctx.appendMessage(message, tabId);
      ctx.persistLocalChatMessage(message, tabId);
    }
  }
  if (data.done) {
    ctx.updateTab(tabId, (tab) => {
      const closedTools = closeRunningToolCards(tab.messages);
      return {
        ...tab,
        waiting: false,
        ...(closedTools.changed ? { messages: closedTools.messages } : {}),
      };
    });
    if (ctx.stateRef.current.activeTabId === tabId) {
      ctx.setStatusFlags({ status: "ready" });
    }
    ctx.setState((prev) => {
      const running = prev.agentRunningTabs as Record<string, true> | undefined;
      if (!running || !running[tabId]) return prev;
      const next = { ...running };
      delete next[tabId];
      return { ...prev, agentRunningTabs: next };
    });
    clearHangWarn(ctx, tabId);
  }
};
