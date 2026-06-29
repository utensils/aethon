import type { A2UIComponent } from "../../types/a2ui";
import A2UIRenderer, {
  type BuiltinComponentProps,
} from "../../components/A2UIRenderer";
import type { ConversationTurn } from "../../utils/transcriptRows";
import type { ToolCallsMode, VisibilityMode } from "../../config";
import type { AgentActivityState } from "../../agentActivity";
import { useDelayedAgentActivity } from "../../agentActivity";
import { ChatMessageRow, TypingIndicator } from "./message-row";
import { branchTargetForTurn } from "./turn-action-helpers";
import { TurnBranchActions } from "./turn-actions";
import { TurnActivity } from "./turn-activity";
import { hasDisplayableAgentContent } from "./turn-activity-helpers";

export interface CanvasFooterContext {
  liveSubtree: { components: A2UIComponent[] } | null;
  agentActivity?: AgentActivityState | null;
  showTyping: boolean;
  typingLabel?: string;
  typingDetail?: string;
  state: Record<string, unknown>;
  tabId?: string;
  rowClassName?: string;
}

// Footer riding below the last message inside Virtuoso's scroller, so the live
// canvas subtree + typing indicator scroll and follow with the messages. Passed
// dynamic data via Virtuoso's `context` so its component identity stays stable.
export function CanvasFooter({ context }: { context?: CanvasFooterContext }) {
  const visibleActivity = useDelayedAgentActivity(
    context?.agentActivity ?? null,
  );
  if (!context) return null;
  const {
    liveSubtree,
    showTyping,
    typingLabel,
    typingDetail,
    state,
    tabId,
    rowClassName = "a2ui-chat-message",
  } = context;
  if (!liveSubtree && !showTyping && !visibleActivity) return null;
  return (
    <>
      {liveSubtree && (
        <div className="a2ui-canvas-live">
          <A2UIRenderer payload={liveSubtree} state={state} tabId={tabId} />
        </div>
      )}
      {visibleActivity ? (
        <div className="a2ui-msg-row a2ui-msg-row-footer">
          <div className="ae-conversation-turn">
            <div className={`${rowClassName} agent ae-typing-message`}>
              <TypingIndicator
                label={visibleActivity.label}
                detail={visibleActivity.detail}
              />
            </div>
          </div>
        </div>
      ) : showTyping ? (
        <div className="a2ui-msg-row a2ui-msg-row-footer">
          <div className="ae-conversation-turn">
            <div className={`${rowClassName} agent ae-typing-message`}>
              <TypingIndicator label={typingLabel} detail={typingDetail} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function hasHiddenThinkingTail(
  turn: ConversationTurn,
  thinkingVisibility: VisibilityMode,
): boolean {
  const tail = turn.agentMessages.at(-1);
  if (!tail) return false;
  return (
    !hasDisplayableAgentContent(tail, thinkingVisibility) &&
    typeof tail.thinking === "string" &&
    tail.thinking.trim().length > 0
  );
}

export function ConversationTurnRow({
  turn,
  state,
  tabId,
  onEvent,
  rowClassName,
  thinkingVisibility,
  toolCallsVisibility,
  expanded,
  onToggle,
  isLatest,
  deliveryText,
}: {
  turn: ConversationTurn;
  state: Record<string, unknown>;
  tabId?: string;
  onEvent?: BuiltinComponentProps["onEvent"];
  rowClassName: string;
  thinkingVisibility: VisibilityMode;
  toolCallsVisibility: ToolCallsMode;
  expanded: boolean;
  onToggle: () => void;
  isLatest: boolean;
  deliveryText?: string;
}) {
  const live = isLatest && state.waiting === true;
  const hasStopNotice = turn.systemMessages.some(
    (message) =>
      message.text?.replace(/\s+/g, " ").trim().toLowerCase() ===
      "agent stopped.",
  );
  const stopped =
    hasStopNotice || (isLatest && !live && state.status === "stopped");
  const interruptedTail =
    !live && hasHiddenThinkingTail(turn, thinkingVisibility);
  const displayableAgentMessages = turn.agentMessages.filter((message) =>
    hasDisplayableAgentContent(message, thinkingVisibility),
  );
  const visibleAgentMessages =
    displayableAgentMessages.length > 0
      ? displayableAgentMessages
      : turn.progressMessages.filter((message) =>
          hasDisplayableAgentContent(message, thinkingVisibility),
        );
  const visibleAgentMessageIds =
    visibleAgentMessages.length > 0
      ? new Set(visibleAgentMessages.map((message) => message.id))
      : undefined;
  const branchTarget = branchTargetForTurn(turn, visibleAgentMessages);
  const userIndex = turn.userMessage
    ? turn.messages.findIndex((message) => message.id === turn.userMessage?.id)
    : -1;
  const preUserSystemMessages =
    userIndex >= 0
      ? turn.systemMessages.filter(
          (message) =>
            turn.messages.findIndex((item) => item.id === message.id) <
            userIndex,
        )
      : turn.systemMessages;
  const postUserSystemMessages =
    userIndex >= 0
      ? turn.systemMessages.filter(
          (message) =>
            turn.messages.findIndex((item) => item.id === message.id) >
            userIndex,
        )
      : [];
  return (
    <div className="ae-conversation-turn">
      {preUserSystemMessages.map((message) => (
        <ChatMessageRow
          key={message.id}
          message={message}
          state={state}
          tabId={tabId}
          className={rowClassName}
          onEvent={onEvent}
          thinkingVisibility={thinkingVisibility}
        />
      ))}
      {turn.userMessage && (
        <ChatMessageRow
          message={turn.userMessage}
          state={state}
          tabId={tabId}
          className={rowClassName}
          onEvent={onEvent}
          deliveryText={deliveryText}
          thinkingVisibility={thinkingVisibility}
        />
      )}
      {visibleAgentMessages.map((message, index) => (
        <ChatMessageRow
          key={message.id}
          message={message}
          state={state}
          tabId={tabId}
          className={rowClassName}
          prevRole={index > 0 ? "agent" : undefined}
          onEvent={onEvent}
          isLatest={message.id === turn.messages.at(-1)?.id}
          thinkingVisibility={thinkingVisibility}
        />
      ))}
      <TurnActivity
        turn={turn}
        state={state}
        tabId={tabId}
        onEvent={onEvent}
        rowClassName={rowClassName}
        thinkingVisibility={thinkingVisibility}
        toolCallsVisibility={toolCallsVisibility}
        expanded={expanded}
        onToggle={onToggle}
        live={live}
        forceOpen={
          stopped || (interruptedTail && visibleAgentMessages.length === 0)
        }
        visibleAgentMessageIds={visibleAgentMessageIds}
      />
      {postUserSystemMessages.map((message) => (
        <ChatMessageRow
          key={message.id}
          message={message}
          state={state}
          tabId={tabId}
          className={rowClassName}
          onEvent={onEvent}
          thinkingVisibility={thinkingVisibility}
        />
      ))}
      <TurnBranchActions
        target={branchTarget}
        state={state}
        tabId={tabId}
        onEvent={onEvent}
      />
    </div>
  );
}
