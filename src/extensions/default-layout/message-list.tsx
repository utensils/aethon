import { useMemo } from "react";
import type {
  A2UIComponent,
  ChatMessage,
  StringValue,
} from "../../types/a2ui";
import A2UIRenderer, {
  type BuiltinComponentProps,
} from "../../components/A2UIRenderer";
import { resolveString } from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import { isRunningToolCard } from "../../utils/toolCardGrouping";
import { resolveVisibility } from "../../utils/visibilityResolver";
import { VirtualMessageFeed } from "./virtual-message-feed";
import { hasDisplayableAgentContent } from "./turn-activity-helpers";
import type { CanvasFooterContext } from "./message-groups";

export { ChatMessageRow } from "./message-row";

function latestMessageHasVisibleAgentContent(messages: readonly ChatMessage[]) {
  const latest = messages.at(-1);
  return (
    latest?.role === "agent" &&
    hasDisplayableAgentContent(latest, "show") &&
    !isRunningToolCard(latest)
  );
}

export function ChatHistory({
  component,
  state,
  tabId,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    messages: { $ref: string };
    emptyHint?: StringValue;
  };

  const messages = useMemo(
    () => (resolvePointer(state, props.messages.$ref) as ChatMessage[]) || [],
    [props.messages.$ref, state],
  );
  const visibility = useMemo(
    () => resolveVisibility(state, tabId),
    [state, tabId],
  );
  const emptyHint = props.emptyHint
    ? resolveString(props.emptyHint, state)
    : "Start a conversation.";

  const scrollToMatchByTab =
    (state.scrollToMatchByTab as Record<string, string> | undefined) ?? {};
  const scrollToMatch = tabId ? scrollToMatchByTab[tabId] : undefined;

  if (messages.length === 0) {
    return (
      <div className="a2ui-chat-history a2ui-chat-history-empty">
        <div className="a2ui-chat-empty">{emptyHint}</div>
      </div>
    );
  }

  return (
    <VirtualMessageFeed
      // Per-tab Virtuoso instance: isolates measurement cache + follow state and
      // lets each tab restore its own scroll position across switches.
      key={tabId ?? "standalone"}
      className="a2ui-chat-history"
      messages={messages}
      state={state}
      tabId={tabId}
      onEvent={onEvent}
      scrollToMatch={scrollToMatch}
      visibility={visibility}
    />
  );
}

export function MainCanvas({
  component,
  state,
  tabId,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    slot?: string;
    messages?: { $ref: string };
    emptyHint?: StringValue;
  };

  const chatMode = props.messages !== undefined;
  const messages = useMemo(
    () =>
      chatMode
        ? (resolvePointer(state, props.messages!.$ref) as ChatMessage[]) || []
        : [],
    [chatMode, props.messages, state],
  );

  const visibility = useMemo(
    () => resolveVisibility(state, tabId),
    [state, tabId],
  );

  const live = props.slot ? resolvePointer(state, props.slot) : null;
  const liveSubtree =
    live && typeof live === "object" && "components" in live
      ? (live as { components: A2UIComponent[] })
      : null;

  const emptyHint = props.emptyHint
    ? resolveString(props.emptyHint, state)
    : "The agent's canvas is empty. Send a message to populate it.";

  // Non-chat canvas: the agent fully owns this surface, no message feed.
  if (!chatMode) {
    return (
      <main className="a2ui-canvas a2ui-canvas-bare">
        {liveSubtree && (
          <div className="a2ui-canvas-live">
            <A2UIRenderer payload={liveSubtree} state={state} tabId={tabId} />
          </div>
        )}
      </main>
    );
  }

  // Empty chat canvas with nothing live yet — just the hint.
  if (messages.length === 0 && !liveSubtree) {
    return (
      <main className="a2ui-canvas a2ui-canvas-empty-host">
        <div className="a2ui-canvas-empty">{emptyHint}</div>
      </main>
    );
  }

  const footerContext: CanvasFooterContext = {
    liveSubtree,
    showTyping:
      state.waiting === true &&
      !liveSubtree &&
      messages.length > 0 &&
      !messages.some(isRunningToolCard),
    ...(latestMessageHasVisibleAgentContent(messages)
      ? {
          typingLabel: "Writing response",
          typingDetail: "Streaming the answer",
        }
      : {}),
    state,
    tabId,
  };

  return (
    <main className="a2ui-canvas a2ui-canvas-host">
      <VirtualMessageFeed
        // Per-tab Virtuoso instance: isolates measurement cache + follow state
        // and lets each tab restore its own scroll position across switches.
        key={tabId ?? "standalone"}
        className="a2ui-canvas-scroller"
        rowClassName="a2ui-canvas-message"
        messages={messages}
        state={state}
        tabId={tabId}
        onEvent={onEvent}
        footerContext={footerContext}
        visibility={visibility}
      />
    </main>
  );
}
