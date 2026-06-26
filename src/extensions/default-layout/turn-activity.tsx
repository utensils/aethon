import { useEffect, useRef, useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import type { ChatMessage } from "../../types/a2ui";
import {
  isRunningToolCard,
  summarizeToolMessages,
  toolCardDetails,
} from "../../utils/toolCardGrouping";
import type { ConversationTurn } from "../../utils/transcriptRows";
import type { ToolCallsMode, VisibilityMode } from "../../config";
import { Chevron } from "./sidebar/chevron";
import { ChatMessageRow } from "./message-row";
import { hasDisplayableAgentContent } from "./turn-activity-helpers";
import {
  activityLabel,
  activityMeta,
  collectFileChangeEntries,
  fileChangeLabel,
  fileChangeStatsLabel,
  hasFileChange,
  hasToolCardChildren,
  summaryWithFileEntries,
  toolDurationLabel,
  toolStateLabel,
  withOpenToolCards,
} from "./tool-activity-summary";
import {
  FileChangeStats,
  ToolFileChangesCard,
  ToolFileChangeRow,
} from "./tool-file-changes";

const ACTIVITY_DISCLOSURE_EXIT_MS = 240;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function ToolActivityRow({
  message,
  onEvent,
}: {
  message: ChatMessage;
  onEvent?: BuiltinComponentProps["onEvent"];
}) {
  const details = toolCardDetails(message);
  if (!details.isToolCard) return null;
  const stateLabel = toolStateLabel(details);
  const duration = toolDurationLabel(details);
  const status = details.isRunning
    ? "running"
    : details.status === "cancelled"
      ? "cancelled"
      : details.isError
        ? "failed"
        : "completed";
  return (
    <div
      className="ae-tool-activity-row"
      data-status={status}
      role="group"
      aria-label={[
        details.title ?? "tool",
        details.description ?? "",
        duration ? `${stateLabel} in ${duration}` : stateLabel,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <span className="ae-tool-activity-dot" aria-hidden="true" />
      <div className="ae-tool-activity-main">
        <div className="ae-tool-activity-line">
          <span className="ae-tool-activity-name">
            {details.title ?? "tool"}
          </span>
          {details.description ? (
            <span className="ae-tool-activity-description">
              {details.description}
            </span>
          ) : null}
        </div>
        {details.fileChange ? (
          <ToolFileChangeRow
            change={details.fileChange}
            onEvent={onEvent}
            componentId={details.componentId}
          />
        ) : null}
      </div>
      <span className="ae-tool-activity-state">
        {duration ? `${stateLabel} in ${duration}` : stateLabel}
      </span>
    </div>
  );
}

export function TurnActivity({
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
  forceOpen,
  visibleAgentMessageIds,
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
  forceOpen: boolean;
  visibleAgentMessageIds?: ReadonlySet<string>;
}) {
  const [closingBodyRetained, setClosingBodyRetained] = useState(false);
  const closingTimerRef = useRef<number | null>(null);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const progressMessages =
    live || forceOpen
      ? []
      : turn.progressMessages.filter(
          (message) =>
            !visibleAgentMessageIds?.has(message.id) &&
            hasDisplayableAgentContent(message, thinkingVisibility),
        );
  const allToolMessages = turn.toolMessages;
  const showGenericTools = toolCallsVisibility !== "hide";
  const summarizedToolMessages = showGenericTools
    ? allToolMessages
    : allToolMessages.filter(hasFileChange);
  const allFileChangeEntries = collectFileChangeEntries(summarizedToolMessages);
  const summary = summaryWithFileEntries(
    summarizeToolMessages(summarizedToolMessages),
    allFileChangeEntries,
  );
  const runningTools = showGenericTools
    ? allToolMessages.filter(isRunningToolCard)
    : [];
  const completedFileActivity =
    !live &&
    summary.fileChanges.total > 0 &&
    summary.running === 0 &&
    summary.failed === 0 &&
    summary.cancelled === 0;
  const defaultDetailsOpen =
    expanded || toolCallsVisibility === "show" || completedFileActivity;
  const detailsOpen = forceOpen || (manualOpen ?? defaultDetailsOpen);
  const detailsBodyVisible = detailsOpen || closingBodyRetained;
  const detailsBodyState = detailsOpen ? "open" : "closing";
  const showOriginalToolCards =
    showGenericTools &&
    forceOpen &&
    !live &&
    (visibleAgentMessageIds?.size ?? 0) === 0;
  const detailTools = detailsBodyVisible ? allToolMessages : [];
  const originalToolCardIds = new Set(
    detailTools
      .filter(
        (message) =>
          showOriginalToolCards ||
          (showGenericTools && hasToolCardChildren(message)),
      )
      .map((message) => message.id),
  );
  const fileChangeEntries =
    detailsBodyVisible && !showOriginalToolCards
      ? collectFileChangeEntries(
          detailTools.filter((message) => !originalToolCardIds.has(message.id)),
        )
      : [];
  const detailToolRows =
    showOriginalToolCards || !showGenericTools
      ? []
      : detailTools.filter(
          (message) =>
            !hasFileChange(message) && !originalToolCardIds.has(message.id),
        );
  const hasActivity =
    progressMessages.length > 0 ||
    summary.fileChanges.total > 0 ||
    (showGenericTools && allToolMessages.length > 0) ||
    runningTools.length > 0;

  useEffect(
    () => () => {
      if (closingTimerRef.current !== null) {
        window.clearTimeout(closingTimerRef.current);
      }
    },
    [],
  );

  if (!hasActivity) return null;
  const label = activityLabel({
    summary,
    progressCount: progressMessages.length,
  });
  const meta = activityMeta(summary);
  const fileLabel = fileChangeLabel(summary);
  const showFileStats = label === fileLabel;
  const accessibleSummary = [
    label,
    meta,
    showFileStats
      ? fileChangeStatsLabel(summary).replace(fileLabel, "").trim()
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const clearClosingTimer = () => {
    if (closingTimerRef.current === null) return;
    window.clearTimeout(closingTimerRef.current);
    closingTimerRef.current = null;
  };
  const handleToggle = () => {
    clearClosingTimer();
    if (detailsOpen) {
      if (prefersReducedMotion()) {
        setClosingBodyRetained(false);
      } else {
        setClosingBodyRetained(true);
        closingTimerRef.current = window.setTimeout(() => {
          setClosingBodyRetained(false);
          closingTimerRef.current = null;
        }, ACTIVITY_DISCLOSURE_EXIT_MS);
      }
    } else {
      setClosingBodyRetained(false);
    }
    setManualOpen(!detailsOpen);
    onToggle();
  };

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
        onClick={handleToggle}
      >
        <span className="ae-turn-block-caret" aria-hidden="true">
          <Chevron expanded={detailsOpen} size={12} />
        </span>
        <span className="ae-turn-block-label">{label}</span>
        {meta ? (
          <>
            <span className="ae-turn-block-separator" aria-hidden="true">
              {" · "}
            </span>
            <span className="ae-turn-block-meta">{meta}</span>
          </>
        ) : null}
        {showFileStats &&
        (summary.fileChanges.additions > 0 ||
          summary.fileChanges.deletions > 0) ? (
          <span className="ae-turn-block-separator" aria-hidden="true">
            {" · "}
          </span>
        ) : null}
        <FileChangeStats summary={summary} hideLabel={showFileStats} />
      </button>
      {detailsBodyVisible && (
        <div className="ae-turn-activity-body" data-state={detailsBodyState}>
          {originalToolCardIds.size > 0
            ? detailTools
                .filter((message) => originalToolCardIds.has(message.id))
                .map((message) => (
                  <ChatMessageRow
                    key={message.id}
                    message={withOpenToolCards(message)}
                    state={state}
                    tabId={tabId}
                    className={`${rowClassName} ae-turn-tool-message`}
                    prevRole="agent"
                    onEvent={onEvent}
                    thinkingVisibility={thinkingVisibility}
                  />
                ))
            : null}
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
          <ToolFileChangesCard
            entries={fileChangeEntries}
            summary={summary}
            onEvent={onEvent}
          />
          {detailToolRows.map((message) => (
            <ToolActivityRow
              key={message.id}
              message={message}
              onEvent={onEvent}
            />
          ))}
        </div>
      )}
      {!detailsOpen && runningTools.length > 0 && (
        <div className="ae-turn-activity-live-tools" data-state="open">
          {runningTools.map((message) => (
            <ToolActivityRow
              key={message.id}
              message={message}
              onEvent={onEvent}
            />
          ))}
        </div>
      )}
    </div>
  );
}
