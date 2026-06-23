import type { A2UIComponent, ChatMessage } from "../../types/a2ui";
import A2UIRenderer, {
  type BuiltinComponentProps,
} from "../../components/A2UIRenderer";
import {
  isRunningToolCard,
  summarizeToolMessages,
  type ToolMessageSummary,
} from "../../utils/toolCardGrouping";
import type { ConversationTurn } from "../../utils/transcriptRows";
import type { ToolCallsMode, VisibilityMode } from "../../config";
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

function compactDuration(ms: number): string {
  if (ms <= 0) return "";
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) {
    return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function toolCountLabel(summary: ToolMessageSummary): string {
  const base = `${summary.total} ${summary.total === 1 ? "tool call" : "tool calls"}`;
  const states: string[] = [];
  if (summary.running > 0) states.push(`${summary.running} running`);
  if (summary.failed > 0) states.push(`${summary.failed} failed`);
  if (summary.cancelled > 0) states.push(`${summary.cancelled} cancelled`);
  return states.length > 0 ? `${base} · ${states.join(" · ")}` : base;
}

function workedLabel(summary: ToolMessageSummary): string {
  const duration = compactDuration(summary.durationMs);
  return duration ? `Worked for ${duration}` : "Agent activity";
}

function fileChangeLabel(summary: ToolMessageSummary): string {
  const changes = summary.fileChanges;
  if (changes.total === 0) return "";
  const verb =
    changes.created > 0 && changes.edited === 0
      ? "Created"
      : changes.edited > 0 && changes.created === 0
        ? "Edited"
        : "Changed";
  const fileText = `${changes.total} ${changes.total === 1 ? "file" : "files"}`;
  return `${verb} ${fileText}`;
}

function FileChangeStats({
  summary,
  hideLabel = false,
}: {
  summary: ToolMessageSummary;
  hideLabel?: boolean;
}) {
  const label = fileChangeLabel(summary);
  if (!label) return null;
  const { additions, deletions } = summary.fileChanges;
  return (
    <span className="ae-turn-block-files">
      {!hideLabel ? (
        <span className="ae-turn-block-files-label">{label}</span>
      ) : null}
      {additions > 0 ? (
        <span className="ae-turn-block-add">+{additions}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="ae-turn-block-del">-{deletions}</span>
      ) : null}
    </span>
  );
}

function activityLabel({
  summary,
  progressCount,
}: {
  summary: ToolMessageSummary;
  progressCount: number;
}): string {
  if (summary.running > 0) {
    return `${summary.running} ${summary.running === 1 ? "tool" : "tools"} running`;
  }
  const fileLabel = fileChangeLabel(summary);
  if (fileLabel) return fileLabel;
  if (summary.total > 0) return workedLabel(summary);
  return `${progressCount} ${progressCount === 1 ? "update" : "updates"}`;
}

function activityMeta({
  summary,
  progressCount,
}: {
  summary: ToolMessageSummary;
  progressCount: number;
}): string {
  const parts: string[] = [];
  if (summary.total > 0) parts.push(toolCountLabel(summary));
  if (progressCount > 0) {
    parts.push(
      `${progressCount} ${progressCount === 1 ? "update" : "updates"}`,
    );
  }
  const peek = summary.names.slice(0, 4).join(" · ");
  if (peek) parts.push(peek);
  return parts.join(" · ");
}

function fileChangeStatsLabel(summary: ToolMessageSummary): string {
  const parts: string[] = [];
  const label = fileChangeLabel(summary);
  if (label) parts.push(label);
  const { additions, deletions } = summary.fileChanges;
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`-${deletions}`);
  return parts.join(" ");
}

function TurnActivity({
  turn,
  state,
  tabId,
  onEvent,
  rowClassName,
  thinkingVisibility,
  toolCallsVisibility,
  expanded,
  onToggle,
  live,
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
  live: boolean;
}) {
  const progressMessages = live ? [] : turn.progressMessages;
  const toolMessages = toolCallsVisibility === "hide" ? [] : turn.toolMessages;
  const summary = summarizeToolMessages(toolMessages);
  const runningTools = toolMessages.filter(isRunningToolCard);
  const detailsOpen = expanded || toolCallsVisibility === "show";
  const visibleTools = detailsOpen ? toolMessages : runningTools;
  const hasActivity =
    progressMessages.length > 0 ||
    toolMessages.length > 0 ||
    visibleTools.length > 0;
  if (!hasActivity) return null;
  const label = activityLabel({
    summary,
    progressCount: progressMessages.length,
  });
  const meta = activityMeta({
    summary,
    progressCount: progressMessages.length,
  });
  const fileLabel = fileChangeLabel(summary);
  const accessibleSummary = [
    label,
    meta,
    label === fileLabel
      ? fileChangeStatsLabel(summary).replace(fileLabel, "").trim()
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="ae-turn-activity"
      data-expanded={detailsOpen ? "true" : "false"}
    >
      <button
        type="button"
        className="ae-turn-activity-summary"
        aria-expanded={detailsOpen}
        aria-label={accessibleSummary}
        onClick={onToggle}
      >
        <span className="ae-turn-block-caret" aria-hidden="true">
          {detailsOpen ? "▾" : "▸"}
        </span>
        <span className="ae-turn-block-label">{label}</span>
        {meta ? <span className="ae-turn-block-meta">{meta}</span> : null}
        <FileChangeStats summary={summary} hideLabel={label === fileLabel} />
      </button>
      {detailsOpen && (
        <div className="ae-turn-activity-body">
          {progressMessages.map((message, index) => (
            <ChatMessageRow
              key={message.id}
              message={message}
              state={state}
              tabId={tabId}
              className={`${rowClassName} ae-turn-progress-message`}
              prevRole={index > 0 ? "agent" : undefined}
              onEvent={onEvent}
              thinkingVisibility={thinkingVisibility}
            />
          ))}
          {visibleTools.map((message) => (
            <ToolGroupChildRow
              key={message.id}
              message={message}
              state={state}
              tabId={tabId}
              onEvent={onEvent}
            />
          ))}
        </div>
      )}
      {!detailsOpen && runningTools.length > 0 && (
        <div className="ae-turn-activity-live-tools">
          {runningTools.map((message) => (
            <ToolGroupChildRow
              key={message.id}
              message={message}
              state={state}
              tabId={tabId}
              onEvent={onEvent}
            />
          ))}
        </div>
      )}
    </div>
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
  const visibleAgentMessages = live
    ? turn.agentMessages
    : turn.finalMessage
      ? [turn.finalMessage]
      : [];
  return (
    <div className="ae-conversation-turn">
      {turn.systemMessages.map((message) => (
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
      />
    </div>
  );
}

export function ToolGroupChildRow({
  message,
  state,
  tabId,
  onEvent,
}: {
  message: ChatMessage;
  state: Record<string, unknown>;
  tabId?: string;
  onEvent?: BuiltinComponentProps["onEvent"];
}) {
  return (
    <div className="ae-tool-group-child-row">
      {message.a2ui ? (
        <A2UIRenderer
          payload={message.a2ui}
          state={state}
          onEvent={forwardNestedA2UIEvent(onEvent)}
          tabId={tabId}
        />
      ) : null}
    </div>
  );
}
