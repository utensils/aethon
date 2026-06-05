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

interface PriorToolCardMatch {
  component: A2UIComponent;
  id: string;
}

function priorToolCardMatch(
  tab: Tab | undefined,
  incomingId: string | undefined,
  identity: string | undefined,
): PriorToolCardMatch | undefined {
  if (!tab) return undefined;
  if (incomingId) {
    for (const message of tab.messages) {
      for (const component of message.a2ui?.components ?? []) {
        if (component?.type !== "tool-card") continue;
        if (component.props?.startedAt === undefined) continue;
        if (component.id === incomingId) {
          return { component, id: incomingId };
        }
      }
    }
  }
  if (!identity) return undefined;
  for (const message of tab.messages) {
    for (const component of message.a2ui?.components ?? []) {
      if (component?.type !== "tool-card") continue;
      if (typeof component.id !== "string") continue;
      if (component.props?.startedAt === undefined) continue;
      if (toolCardIdentityFromId(component.id) === identity) {
        return { component, id: component.id };
      }
    }
  }
  return undefined;
}

function isCancelledToolCard(component: A2UIComponent | undefined): boolean {
  return (
    component?.type === "tool-card" && component.props?.status === "cancelled"
  );
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
    const tabs = (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
    const tab = tabs.find((t) => t.id === tabId);
    const completedCard = completedToolCard(payload);
    const identity = completedCard
      ? toolCardIdentityFromId(completedCard.id)
      : undefined;
    const priorMatch = priorToolCardMatch(tab, completedCard?.id, identity);
    const finalPayload =
      isCancelledToolCard(priorMatch?.component) &&
      payload.components?.some(isCancelledToolCard) !== true
        ? preserveCancelledToolState(payload)
        : payload;
    const message: ChatMessage = {
      id,
      role: "agent",
      a2ui: finalPayload,
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
    if (priorMatch) {
      ctx.updateTab(tabId, (current) => ({
        ...current,
        messages: current.messages.map((currentMessage) => {
          const matches = (currentMessage.a2ui?.components ?? []).some(
            (component) => {
              if (component?.type !== "tool-card") return false;
              if (component.props?.startedAt === undefined) return false;
              return component.id === priorMatch.id;
            },
          );
          return matches ? message : currentMessage;
        }),
      }));
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
  }
};
