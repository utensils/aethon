import type { A2UIPayload } from "../../types/a2ui";
import type { Tab } from "../../types/tab";
import { toolCardIdentityFromId } from "../../utils/toolCardIdentity";
import type { BridgeMessageHandler } from "./types";
import { flushResponseDeltas } from "./responseDelta";

function completedToolCardIdentity(payload: A2UIPayload): string | undefined {
  const toolCards = (payload.components ?? []).filter(
    (component) =>
      component?.type === "tool-card" && typeof component.id === "string",
  );
  if (toolCards.length !== 1) return undefined;
  const component = toolCards[0];
  if (component.props?.startedAt === undefined) return undefined;
  if (component.props.endedAt === undefined) return undefined;
  return toolCardIdentityFromId(component.id);
}

function replacesRunningToolCard(
  tab: Tab | undefined,
  incomingMessageId: string,
  identity: string | undefined,
): boolean {
  if (!tab || !identity) return false;
  return tab.messages.some((message) => {
    if (message.id === incomingMessageId) return false;
    const toolCards = message.a2ui?.components ?? [];
    return toolCards.some((component) => {
      if (component?.type !== "tool-card") return false;
      if (typeof component.id !== "string") return false;
      if (component.props?.startedAt === undefined) return false;
      if (component.props.endedAt !== undefined) return false;
      return toolCardIdentityFromId(component.id) === identity;
    });
  });
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
    const tabs = (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
    const tab = tabs.find((t) => t.id === tabId);
    const identity = completedToolCardIdentity(payload);
    if (replacesRunningToolCard(tab, id, identity)) {
      ctx.updateTab(tabId, (current) => ({
        ...current,
        messages: current.messages.map((message) => {
          const matches = (message.a2ui?.components ?? []).some(
            (component) =>
              component?.type === "tool-card" &&
              typeof component.id === "string" &&
              component.props?.startedAt !== undefined &&
              component.props.endedAt === undefined &&
              toolCardIdentityFromId(component.id) === identity,
          );
          return matches ? { id, role: "agent", a2ui: payload } : message;
        }),
      }));
    } else {
      ctx.appendMessage({ id, role: "agent", a2ui: payload }, tabId);
    }
  }
  if (data.done) {
    ctx.updateTab(tabId, (tab) => ({ ...tab, waiting: false }));
    if (ctx.stateRef.current.activeTabId === tabId) {
      ctx.setStatusFlags({ status: "ready" });
    }
  }
};
