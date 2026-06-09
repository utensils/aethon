import type { A2UIComponent, A2UIPayload, ChatMessage } from "../../types/a2ui";
import type { Tab } from "../../types/tab";
import { closeRunningToolCards } from "../../utils/agentBusy";
import { toolCardIdentityFromId } from "../../utils/toolCardIdentity";
import type { BridgeMessageHandler } from "./types";
import { flushResponseDeltas } from "./responseDelta";

function completedToolCard(payload: A2UIPayload): A2UIComponent | undefined {
  const toolCards = (payload.components ?? []).filter(
    (component) =>
      component?.type === "tool-card" && typeof component.id === "string",
  );
  if (toolCards.length !== 1) return undefined;
  const component = toolCards[0];
  if (component.props?.startedAt === undefined) return undefined;
  if (component.props.endedAt === undefined) return undefined;
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
): boolean {
  if (component?.type !== "tool-card") return false;
  if (component.props?.startedAt === undefined) return false;
  return (
    typeof component.id === "string" &&
    toolCardIdentityFromId(component.id) === identity
  );
}

function findCurrentToolCardMatch(
  messages: ChatMessage[],
  incomingId: string | undefined,
  identity: string | undefined,
): { index: number; component: A2UIComponent } | undefined {
  if (incomingId) {
    for (let index = 0; index < messages.length; index += 1) {
      const component = (messages[index].a2ui?.components ?? []).find((item) =>
        componentMatchesIncomingToolId(item, incomingId),
      );
      if (component) return { index, component };
    }
  }
  if (!identity) return undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const component = (messages[index].a2ui?.components ?? []).find((item) =>
      componentMatchesToolIdentity(item, identity),
    );
    if (component) return { index, component };
  }
  return undefined;
}

function insertChronologically(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  if (typeof message.createdAt !== "number") return [...messages, message];
  const insertAt = messages.findIndex(
    (current) =>
      typeof current.createdAt === "number" &&
      current.createdAt > message.createdAt!,
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

function preserveCancelledToolState(payload: A2UIPayload): A2UIPayload {
  return {
    ...payload,
    components: (payload.components ?? []).map((component) => {
      if (component?.type !== "tool-card") return component;
      return {
        ...component,
        props: {
          ...(component.props ?? {}),
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

function upsertCompletedToolCardMessage(
  current: Tab,
  message: ChatMessage,
  payload: A2UIPayload,
  completedCard: A2UIComponent,
  identity: string | undefined,
): Tab {
  const incomingId = completedCard.id;
  const matched = findCurrentToolCardMatch(
    current.messages,
    incomingId,
    identity,
  );
  if (matched) {
    const finalPayload =
      isCancelledToolCard(matched.component) &&
      payload.components?.some(isCancelledToolCard) !== true
        ? preserveCancelledToolState(payload)
        : payload;
    const nextMessages = [...current.messages];
    nextMessages[matched.index] = { ...message, a2ui: finalPayload };
    return { ...current, messages: nextMessages };
  }

  const sameMessageIndex = current.messages.findIndex(
    (currentMessage) =>
      currentMessage.id === message.id ||
      messageMatchesToolCardId(currentMessage, incomingId),
  );
  if (sameMessageIndex >= 0) {
    const replacedMessages = [...current.messages];
    replacedMessages[sameMessageIndex] = message;
    return { ...current, messages: replacedMessages };
  }

  return {
    ...current,
    messages: insertChronologically(current.messages, message),
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
    const completedCard = completedToolCard(payload);
    const identity = completedCard
      ? toolCardIdentityFromId(completedCard.id)
      : undefined;
    const message: ChatMessage = {
      id,
      role: "agent",
      a2ui: payload,
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
    if (completedCard) {
      ctx.updateTab(tabId, (current) =>
        upsertCompletedToolCardMessage(
          current,
          message,
          payload,
          completedCard,
          identity,
        ),
      );
    } else {
      ctx.appendMessage(message, tabId);
    }
    ctx.persistLocalChatMessage(message, tabId);
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
  }
};
