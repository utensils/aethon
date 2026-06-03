import type { A2UIComponent, ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";

function componentHasRunningToolCard(
  component: A2UIComponent | undefined,
): boolean {
  if (!component) return false;
  if (
    component.type === "tool-card" &&
    component.props?.startedAt !== undefined &&
    component.props.endedAt === undefined
  ) {
    return true;
  }
  return (component.children ?? []).some(componentHasRunningToolCard);
}

/** True when the transcript still contains a visible tool card that has
 *  started but has not received its terminal update. This catches the edge
 *  case where `waiting` drifted false while the UI still shows a live tool. */
export function hasRunningToolCard(
  messages: readonly ChatMessage[] | undefined,
): boolean {
  return (messages ?? []).some((message) =>
    (message.a2ui?.components ?? []).some(componentHasRunningToolCard),
  );
}

/** A turn is actively in flight for an agent tab. Queue state is intentionally
 *  excluded: queued messages are pending client work, not an active command. */
export function isAgentTabInFlight(
  tab: Pick<Tab, "kind" | "waiting" | "messages"> | undefined,
): boolean {
  if (!tab) return false;
  if ((tab.kind ?? "agent") !== "agent") return false;
  return tab.waiting === true || hasRunningToolCard(tab.messages);
}

/** UI-level busy predicate. Used by controls that should also react to queued
 *  messages (for example Escape/Stop), while in-flight-only callers can use
 *  `isAgentTabInFlight` directly. */
export function isAgentTabBusy(
  tab:
    | Pick<
        Tab,
        "kind" | "waiting" | "messages" | "queueCount" | "queuedMessages"
      >
    | undefined,
  options: { includeQueue?: boolean } = {},
): boolean {
  if (!tab) return false;
  if (isAgentTabInFlight(tab)) return true;
  if (options.includeQueue !== true) return false;
  return (tab.queuedMessages?.length ?? tab.queueCount ?? 0) > 0;
}

export interface CloseRunningToolCardsOptions {
  endedAt?: number;
  status?: string;
  notice?: string;
}

function toolCardClosedNotice(
  componentId: string,
  content: string,
): A2UIComponent {
  return {
    id: `${componentId}-closed-notice`,
    type: "code",
    props: { content, language: "text" },
  };
}

function closeRunningToolCardComponent(
  component: A2UIComponent,
  endedAt: number,
  status: string,
  notice: string,
): { component: A2UIComponent; changed: boolean } {
  let childrenChanged = false;
  const nextChildren = (component.children ?? []).map((child) => {
    const next = closeRunningToolCardComponent(child, endedAt, status, notice);
    childrenChanged = childrenChanged || next.changed;
    return next.component;
  });

  if (
    component.type === "tool-card" &&
    component.props?.startedAt !== undefined &&
    component.props.endedAt === undefined
  ) {
    return {
      changed: true,
      component: {
        ...component,
        props: {
          ...(component.props ?? {}),
          status,
          endedAt,
        },
        children: [
          ...nextChildren,
          toolCardClosedNotice(component.id, notice),
        ],
      },
    };
  }

  if (!childrenChanged) return { component, changed: false };
  return { component: { ...component, children: nextChildren }, changed: true };
}

/** Freeze any still-running tool-card timers once the surrounding turn has
 *  definitely ended. This prevents a stale visual card from keeping the
 *  frontend busy predicate true forever. */
export function closeRunningToolCards(
  messages: readonly ChatMessage[],
  options: CloseRunningToolCardsOptions = {},
): { messages: ChatMessage[]; changed: boolean } {
  let changed = false;
  const endedAt = options.endedAt ?? Date.now();
  const status = options.status ?? "cancelled";
  const notice =
    options.notice ?? "Tool call did not finish before the turn ended.";
  const nextMessages = messages.map((message): ChatMessage => {
    const components = message.a2ui?.components;
    if (!components) return message;
    let messageChanged = false;
    const nextComponents = components.map((component): A2UIComponent => {
      const next = closeRunningToolCardComponent(
        component,
        endedAt,
        status,
        notice,
      );
      messageChanged = messageChanged || next.changed;
      return next.component;
    });
    if (!messageChanged) return message;
    changed = true;
    return {
      ...message,
      a2ui: {
        ...message.a2ui,
        components: nextComponents,
      },
    };
  });
  return { messages: nextMessages, changed };
}
