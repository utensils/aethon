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
import { LiveActivityCard } from "./live-activity-card";
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
  liveActivitySummary,
  summaryWithFileEntries,
  toolDurationLabel,
  toolStateLabel,
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
  const [allExpanded, setAllExpanded] = useState(false);
  const turnRef = useRef<HTMLDivElement>(null);
  const setAllToolCardsOpen = (next: boolean) => {
    setAllExpanded(next);
    // Dispatch only to the cards inside THIS turn's subtree so sibling
    // turns are unaffected.
    turnRef.current
      ?.querySelectorAll(".ae-tool-card")
      .forEach((el) =>
        el.dispatchEvent(
          new CustomEvent("aethon:tool-card-set-open", {
            detail: { open: next },
          }),
        ),
      );
  };
  const progressMessages =
    live || forceOpen
      ? []
      : turn.progressMessages.filter(
          (message) =>
            !visibleAgentMessageIds?.has(message.id) &&
            hasDisplayableAgentContent(message, thinkingVisibility),
        );
  const showGenericTools = toolCallsVisibility !== "hide";
  const allToolMessages = turn.toolMessages;
  const runningTools = allToolMessages.filter(isRunningToolCard);
  const summarizedToolMessages = showGenericTools
    ? allToolMessages
    : live
      ? runningTools
      : allToolMessages.filter(hasFileChange);
  const allFileChangeEntries = collectFileChangeEntries(summarizedToolMessages);
  const summary = summaryWithFileEntries(
    summarizeToolMessages(summarizedToolMessages),
    allFileChangeEntries,
  );
  const completedFileActivity =
    !live &&
    summary.fileChanges.total > 0 &&
    summary.running === 0 &&
    summary.failed === 0 &&
    summary.cancelled === 0;
  const liveOnlyActivity = live && !showGenericTools && runningTools.length > 0;
  const hiddenLiveSummary = liveOnlyActivity
    ? liveActivitySummary(runningTools)
    : null;
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
  // The aggregated "Edited N files" card is the durable artifact of a turn,
  // so it stays visible regardless of the tool-calls visibility toggle or
  // whether the activity body is expanded. When tool cards render in full
  // (showOriginalToolCards) each edit shows its own change, so skip it then
  // to avoid duplication.
  const pinnedFileChangeEntries = showOriginalToolCards
    ? []
    : collectFileChangeEntries(allToolMessages.filter(hasFileChange));
  const detailToolRows =
    liveOnlyActivity && detailsBodyVisible
      ? runningTools
      : showOriginalToolCards || !showGenericTools
        ? []
        : detailTools.filter(
            (message) =>
              !hasFileChange(message) && !originalToolCardIds.has(message.id),
          );
  const hasActivity =
    progressMessages.length > 0 ||
    summary.fileChanges.total > 0 ||
    summarizedToolMessages.length > 0 ||
    runningTools.length > 0;

  useEffect(
    () => () => {
      if (closingTimerRef.current !== null) {
        window.clearTimeout(closingTimerRef.current);
      }
    },
    [],
  );

  // Cards remount collapsed when the body is hidden, so keep the toolbar's
  // "Expand all / Collapse all" label in sync rather than leaving it stale.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resync the toolbar label to body visibility
    if (!detailsBodyVisible) setAllExpanded(false);
  }, [detailsBodyVisible]);

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

  if (hiddenLiveSummary) {
    return (
      <div
        ref={turnRef}
        className="ae-turn-activity ae-turn-activity-live-only"
        data-expanded="false"
      >
        <LiveActivityCard
          label={hiddenLiveSummary.label}
          detail={hiddenLiveSummary.detail}
        />
      </div>
    );
  }

  return (
    <div
      ref={turnRef}
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
          {originalToolCardIds.size > 0 && (
            <div className="ae-turn-activity-toolbar">
              <button
                type="button"
                className="ae-turn-activity-expand-all"
                aria-expanded={allExpanded}
                onClick={() => setAllToolCardsOpen(!allExpanded)}
              >
                {allExpanded ? "Collapse all" : "Expand all"}
              </button>
            </div>
          )}
          {originalToolCardIds.size > 0
            ? detailTools
                .filter((message) => originalToolCardIds.has(message.id))
                .map((message) => (
                  <ChatMessageRow
                    key={message.id}
                    message={message}
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
      {pinnedFileChangeEntries.length > 0 && (
        <ToolFileChangesCard
          entries={pinnedFileChangeEntries}
          summary={summary}
          onEvent={onEvent}
        />
      )}
    </div>
  );
}
