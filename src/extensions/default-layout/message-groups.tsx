import type { A2UIComponent, ChatMessage } from "../../types/a2ui";
import A2UIRenderer, {
  type BuiltinComponentProps,
} from "../../components/A2UIRenderer";
import {
  isToolCardMessage,
  type MessageGroup,
} from "../../utils/toolCardGrouping";
import type { VisibilityMode } from "../../config";
import { ChatMessageRow, TypingIndicator } from "./message-row";
import { forwardNestedA2UIEvent } from "./message-rendering-utils";

export interface CanvasFooterContext {
  liveSubtree: { components: A2UIComponent[] } | null;
  showTyping: boolean;
  state: Record<string, unknown>;
  tabId?: string;
}

// Footer riding below the last message inside Virtuoso's scroller, so the live
// canvas subtree + typing indicator scroll and follow with the messages. Passed
// dynamic data via Virtuoso's `context` so its component identity stays stable.
export function CanvasFooter({ context }: { context?: CanvasFooterContext }) {
  if (!context) return null;
  const { liveSubtree, showTyping, state, tabId } = context;
  if (!liveSubtree && !showTyping) return null;
  return (
    <>
      {liveSubtree && (
        <div className="a2ui-canvas-live">
          <A2UIRenderer payload={liveSubtree} state={state} tabId={tabId} />
        </div>
      )}
      {showTyping && <TypingIndicator />}
    </>
  );
}

/** Title shown on a tool-call card (e.g. "bash", "read"), used for the
 *  collapsed-group peek. */
function toolCardTitle(m: ChatMessage): string | undefined {
  const comp = m.a2ui?.components?.find((c) => c?.type === "tool-card");
  const title = comp?.props?.title;
  return typeof title === "string" && title.length > 0 ? title : undefined;
}

/** A short "name · name · …" peek of the tools inside a collapsed group, so the
 *  user can tell what's hidden without expanding. Caps at 4 names. */
function toolPeek(messages: ChatMessage[]): string {
  const names = messages
    .map(toolCardTitle)
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return "";
  const shown = names.slice(0, 4).join(" · ");
  return names.length > 4 ? `${shown} · …` : shown;
}

/** Collapsed cluster of completed tool-call cards (tool visibility =
 *  "group-run" / "group-turn"). One disclosure row labelled "N tool calls"
 *  with a name peek, expanding to the individual cards. Expansion is local UI
 *  state in VirtualMessageFeed. */
export function ToolGroupRow({
  group,
  state,
  tabId,
  onEvent,
  expanded,
  onToggle,
}: {
  group: Extract<MessageGroup, { type: "tool-group" }>;
  state: Record<string, unknown>;
  tabId?: string;
  onEvent?: BuiltinComponentProps["onEvent"];
  expanded: boolean;
  onToggle: () => void;
}) {
  const count = group.messages.length;
  const peek = toolPeek(group.messages);
  return (
    <div className="ae-tool-group" data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        className="ae-tool-group-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="ae-tool-group-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="ae-tool-group-label">{count} tool calls</span>
        {!expanded && peek && (
          <span className="ae-tool-group-peek">{peek}</span>
        )}
      </button>
      {expanded && (
        <div className="ae-tool-group-body">
          {group.messages.map((m) =>
            m.a2ui ? (
              <A2UIRenderer
                key={m.id}
                payload={m.a2ui}
                state={state}
                onEvent={forwardNestedA2UIEvent(onEvent)}
                tabId={tabId}
              />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

/** Header label for a folded agent turn: "N replies · M tool calls". Counts
 *  only text-bearing non-tool messages as replies — a thinking-only message
 *  may render nothing when thinking is hidden, so it shouldn't inflate the
 *  count. */
function turnBlockLabel(messages: ChatMessage[]): string {
  const tools = messages.filter(isToolCardMessage).length;
  const replies = messages.filter(
    (m) => !isToolCardMessage(m) && Boolean(m.text),
  ).length;
  const parts: string[] = [];
  if (replies > 0) {
    parts.push(`${replies} ${replies === 1 ? "reply" : "replies"}`);
  }
  parts.push(`${tools} ${tools === 1 ? "tool call" : "tool calls"}`);
  return parts.join(" · ");
}

/** A whole completed agent turn folded into one collapsible block (tool
 *  visibility = "group-block"). Expands to the turn's messages — narration and
 *  tool cards — rendered in order via ChatMessageRow. */
export function TurnBlockRow({
  group,
  state,
  tabId,
  onEvent,
  rowClassName,
  thinkingVisibility,
  expanded,
  onToggle,
}: {
  group: Extract<MessageGroup, { type: "turn-block" }>;
  state: Record<string, unknown>;
  tabId?: string;
  onEvent?: BuiltinComponentProps["onEvent"];
  rowClassName: string;
  thinkingVisibility: VisibilityMode;
  expanded: boolean;
  onToggle: () => void;
}) {
  const peek = toolPeek(group.messages);
  return (
    <div className="ae-turn-block" data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        className="ae-turn-block-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="ae-turn-block-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="ae-turn-block-label">Agent turn</span>
        <span className="ae-turn-block-meta">
          {turnBlockLabel(group.messages)}
        </span>
        {!expanded && peek && (
          <span className="ae-turn-block-peek">{peek}</span>
        )}
      </button>
      {expanded && (
        <div className="ae-turn-block-body">
          {group.messages.map((m, i) => (
            <ChatMessageRow
              key={m.id}
              message={m}
              state={state}
              tabId={tabId}
              className={rowClassName}
              prevRole={i > 0 ? group.messages[i - 1].role : undefined}
              onEvent={onEvent}
              thinkingVisibility={thinkingVisibility}
            />
          ))}
        </div>
      )}
    </div>
  );
}
