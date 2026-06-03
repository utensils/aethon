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
  tab:
    | Pick<Tab, "kind" | "waiting" | "messages">
    | undefined,
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
  return (tab.queueCount ?? tab.queuedMessages?.length ?? 0) > 0;
}
