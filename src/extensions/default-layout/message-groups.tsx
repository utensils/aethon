import { useEffect, useRef, useState } from "react";
import type { A2UIComponent, ChatMessage } from "../../types/a2ui";
import A2UIRenderer, {
  type BuiltinComponentProps,
} from "../../components/A2UIRenderer";
import { FileIcon } from "../../components/file-icon";
import { Chevron } from "./sidebar/chevron";
import {
  isRunningToolCard,
  summarizeToolMessages,
  toolCardDetails,
  type ToolCardFileChange,
  type ToolMessageSummary,
} from "../../utils/toolCardGrouping";
import type { ConversationTurn } from "../../utils/transcriptRows";
import type { ToolCallsMode, VisibilityMode } from "../../config";
import { ChatMessageRow, tabIsRunning, TypingIndicator } from "./message-row";

const ACTIVITY_DISCLOSURE_EXIT_MS = 240;

export interface CanvasFooterContext {
  liveSubtree: { components: A2UIComponent[] } | null;
  showTyping: boolean;
  state: Record<string, unknown>;
  tabId?: string;
  rowClassName?: string;
}

// Footer riding below the last message inside Virtuoso's scroller, so the live
// canvas subtree + typing indicator scroll and follow with the messages. Passed
// dynamic data via Virtuoso's `context` so its component identity stays stable.
export function CanvasFooter({ context }: { context?: CanvasFooterContext }) {
  if (!context) return null;
  const {
    liveSubtree,
    showTyping,
    state,
    tabId,
    rowClassName = "a2ui-chat-message",
  } = context;
  if (!liveSubtree && !showTyping) return null;
  return (
    <>
      {liveSubtree && (
        <div className="a2ui-canvas-live">
          <A2UIRenderer payload={liveSubtree} state={state} tabId={tabId} />
        </div>
      )}
      {showTyping && (
        <div className="a2ui-msg-row a2ui-msg-row-footer">
          <div className="ae-conversation-turn">
            <div className={`${rowClassName} agent ae-typing-message`}>
              <TypingIndicator />
            </div>
          </div>
        </div>
      )}
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
      {additions > 0 && deletions > 0 ? " " : null}
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

function activityMeta(summary: ToolMessageSummary): string {
  if (summary.fileChanges.total > 0) return "";
  return summary.total > 0 ? toolCountLabel(summary) : "";
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

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface ToolFileChangeEntry {
  change: ToolCardFileChange;
  componentId?: string;
}

interface LineChangeStats {
  additions: number;
  deletions: number;
}

function collectFileChangeEntries(
  messages: readonly ChatMessage[],
): ToolFileChangeEntry[] {
  const entries = new Map<string, ToolFileChangeEntry>();
  for (const message of messages) {
    const details = toolCardDetails(message);
    if (!details.fileChange?.path) continue;
    const key = statsKey(details.fileChange.rootPath, details.fileChange.path);
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, {
        change: details.fileChange,
        ...(details.componentId ? { componentId: details.componentId } : {}),
      });
      continue;
    }
    const prior = existing.change;
    const priorPreview = looksLikeUnifiedDiff(prior.preview)
      ? prior.preview
      : "";
    const nextPreview = looksLikeUnifiedDiff(details.fileChange.preview)
      ? details.fileChange.preview
      : "";
    const additions =
      (prior.additions ?? 0) + (details.fileChange.additions ?? 0);
    const deletions =
      (prior.deletions ?? 0) + (details.fileChange.deletions ?? 0);
    entries.set(key, {
      change: {
        ...prior,
        kind:
          prior.kind === "created" || details.fileChange.kind === "created"
            ? "created"
            : "edited",
        rootPath: prior.rootPath ?? details.fileChange.rootPath,
        ...(priorPreview || nextPreview
          ? {
              preview: [priorPreview, nextPreview].filter(Boolean).join("\n\n"),
            }
          : {}),
        ...(additions > 0 ? { additions } : {}),
        ...(deletions > 0 ? { deletions } : {}),
      },
      componentId: details.componentId ?? existing.componentId,
    });
  }
  return Array.from(entries.values());
}

function hasFileChange(message: ChatMessage): boolean {
  return Boolean(toolCardDetails(message).fileChange?.path);
}

function hasToolCardChildren(message: ChatMessage): boolean {
  return Boolean(
    message.a2ui?.components?.some(
      (component) =>
        component.type === "tool-card" && (component.children?.length ?? 0) > 0,
    ),
  );
}

function withOpenToolCards(message: ChatMessage): ChatMessage {
  if (!message.a2ui?.components?.length) return message;
  return {
    ...message,
    a2ui: {
      ...message.a2ui,
      components: message.a2ui.components.map((component) =>
        component.type === "tool-card"
          ? {
              ...component,
              props: {
                ...component.props,
                defaultOpen: true,
              },
            }
          : component,
      ),
    },
  };
}

function basename(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || path
  );
}

function parentPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx > 0 ? trimmed.slice(0, idx) : "";
}

function previewLines(preview: string): string[] {
  return preview
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .slice(0, 80);
}

function looksLikeUnifiedDiff(preview: string | undefined): preview is string {
  if (!preview) return false;
  return /(^|\n)(diff --git |@@ |--- |\+\+\+ )/.test(preview);
}

function statsKey(rootPath: string | undefined, filePath: string): string {
  return `${rootPath ?? ""}\0${filePath}`;
}

function statsFromChange(change: ToolCardFileChange): LineChangeStats {
  return {
    additions: change.additions ?? 0,
    deletions: change.deletions ?? 0,
  };
}

function effectiveStats(change: ToolCardFileChange): LineChangeStats {
  const captured = statsFromChange(change);
  return captured;
}

function summaryWithFileEntries(
  summary: ToolMessageSummary,
  entries: readonly ToolFileChangeEntry[],
): ToolMessageSummary {
  if (entries.length === 0) return summary;
  let created = 0;
  let edited = 0;
  let additions = 0;
  let deletions = 0;
  for (const { change } of entries) {
    if (change.kind === "created") created += 1;
    else edited += 1;
    const stats = effectiveStats(change);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return {
    ...summary,
    fileChanges: {
      total: entries.length,
      created,
      edited,
      additions,
      deletions,
    },
  };
}

function lineTone(line: string): "add" | "del" | "hunk" | "meta" | "ctx" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("+++") ||
    line.startsWith("---")
  ) {
    return "meta";
  }
  return "ctx";
}

function toolStateLabel(details: ReturnType<typeof toolCardDetails>): string {
  if (details.isRunning) return "Running";
  if (details.status === "cancelled") return "Cancelled";
  if (details.isError) return "Failed";
  return "Completed";
}

function toolDurationLabel(
  details: ReturnType<typeof toolCardDetails>,
): string {
  if (details.startedAt === undefined || details.endedAt === undefined) {
    return "";
  }
  return compactDuration(Math.max(0, details.endedAt - details.startedAt));
}

function ToolFileChangeRow({
  change,
  onEvent,
  componentId,
}: {
  change: ToolCardFileChange;
  onEvent?: BuiltinComponentProps["onEvent"];
  componentId?: string;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const filePath = change.path ?? "";
  if (!filePath) return null;
  const { additions, deletions } = effectiveStats(change);
  const dir = parentPath(filePath);
  const capturedDiff = looksLikeUnifiedDiff(change.preview)
    ? change.preview
    : "";
  const eventPayload = {
    filePath,
    ...(change.rootPath ? { rootPath: change.rootPath } : {}),
    ...(capturedDiff
      ? {
          diffSnapshot: {
            format: "unified",
            content: capturedDiff,
            ...(additions > 0 ? { additions } : {}),
            ...(deletions > 0 ? { deletions } : {}),
            source: "tool-card",
          },
        }
      : {}),
  };
  const togglePreview = () => {
    setPreviewOpen((open) => !open);
  };
  return (
    <div className="ae-tool-activity-file-item">
      <div className="ae-tool-activity-file">
        <button
          type="button"
          className="ae-tool-activity-file-open"
          title={`Open diff for ${filePath}`}
          onClick={() => onEvent?.("tool-file-diff", eventPayload, componentId)}
        >
          <FileIcon
            path={filePath}
            isDir={false}
            className="ae-tool-activity-file-icon"
          />
          <span className="ae-tool-activity-file-name">
            {basename(filePath)}
          </span>
          {dir ? (
            <span className="ae-tool-activity-file-dir">{dir}</span>
          ) : null}
        </button>
        {(additions > 0 || deletions > 0) && (
          <span
            className="ae-tool-activity-file-stat"
            aria-label="Line changes"
          >
            {additions > 0 ? (
              <span className="ae-turn-block-add">+{additions}</span>
            ) : null}
            {deletions > 0 ? (
              <span className="ae-turn-block-del">-{deletions}</span>
            ) : null}
          </span>
        )}
        <button
          type="button"
          className="ae-tool-activity-file-source"
          title={`Open ${filePath}`}
          aria-label={`Open ${basename(filePath)}`}
          onClick={() => onEvent?.("tool-file-open", eventPayload, componentId)}
        >
          Open
        </button>
        {capturedDiff ? (
          <button
            type="button"
            className="ae-tool-activity-file-preview-toggle"
            title={`${previewOpen ? "Hide" : "Show"} inline diff for ${filePath}`}
            aria-label={`${previewOpen ? "Hide" : "Show"} inline diff for ${basename(filePath)}`}
            aria-expanded={previewOpen}
            onClick={togglePreview}
          >
            <Chevron expanded={previewOpen} />
          </button>
        ) : null}
      </div>
      {previewOpen && capturedDiff ? (
        <pre className="ae-tool-file-diff-preview ae-tool-activity-file-preview">
          <code>
            {previewLines(capturedDiff).map((line, index) => (
              <span
                key={`${index}-${line}`}
                className={`ae-tool-file-diff-line is-${lineTone(line)}`}
              >
                <span className="ae-tool-file-diff-lineno">{index + 1}</span>
                <span className="ae-tool-file-diff-text">{line || " "}</span>
              </span>
            ))}
          </code>
        </pre>
      ) : previewOpen ? (
        <div className="ae-tool-activity-file-preview-empty">
          No stored diff snapshot is available for this tool record.
        </div>
      ) : null}
    </div>
  );
}

function ToolFileChangesCard({
  entries,
  summary,
  onEvent,
}: {
  entries: ToolFileChangeEntry[];
  summary: ToolMessageSummary;
  onEvent?: BuiltinComponentProps["onEvent"];
}) {
  const label = fileChangeLabel(summary);
  if (entries.length === 0) return null;
  const displaySummary = summaryWithFileEntries(summary, entries);
  const statLabel = fileChangeStatsLabel(displaySummary);
  return (
    <div className="ae-file-activity-card" role="group" aria-label={statLabel}>
      <div className="ae-file-activity-head">
        <span className="ae-file-activity-icon" aria-hidden="true">
          ✎
        </span>
        <span className="ae-file-activity-title">{label}</span>
        <FileChangeStats summary={displaySummary} hideLabel />
      </div>
      <div className="ae-file-activity-list">
        {entries.map(({ change, componentId }) => (
          <ToolFileChangeRow
            key={`${componentId ?? ""}:${change.path}`}
            change={change}
            onEvent={onEvent}
            componentId={componentId}
          />
        ))}
      </div>
    </div>
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
          {detailsOpen ? "▾" : "▸"}
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

function hasDisplayableAgentContent(
  message: ChatMessage,
  thinkingVisibility: VisibilityMode,
): boolean {
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return true;
  }
  if (message.a2ui) return true;
  return (
    thinkingVisibility === "show" &&
    typeof message.thinking === "string" &&
    message.thinking.trim().length > 0
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

function isBranchableTurnMessage(message: ChatMessage): boolean {
  return (
    Boolean(message.entryId) &&
    (message.role === "user" || message.role === "agent") &&
    (Boolean(message.text) || Boolean(message.thinking))
  );
}

function branchTargetForTurn(
  turn: ConversationTurn,
  visibleAgentMessages: ChatMessage[],
): ChatMessage | undefined {
  return [turn.userMessage, ...visibleAgentMessages]
    .filter((message): message is ChatMessage => Boolean(message))
    .filter(isBranchableTurnMessage)
    .at(-1);
}

function tabCwdFromState(
  state: Record<string, unknown>,
  tabId: string | undefined,
): string | undefined {
  if (!tabId || !Array.isArray(state.tabs)) return undefined;
  const tab = state.tabs.find(
    (candidate): candidate is { id: string; cwd?: string } =>
      Boolean(
        candidate &&
          typeof candidate === "object" &&
          "id" in candidate &&
          candidate.id === tabId,
      ),
  );
  return typeof tab?.cwd === "string" ? tab.cwd : undefined;
}

function branchEventPayload(
  target: ChatMessage,
  tabId: string | undefined,
  state: Record<string, unknown>,
) {
  const cwd = target.cwd ?? tabCwdFromState(state, tabId);
  return {
    entryId: target.entryId,
    tabId,
    ...(cwd ? { cwd } : {}),
  };
}

function TurnBranchActions({
  target,
  state,
  tabId,
  onEvent,
}: {
  target?: ChatMessage;
  state: Record<string, unknown>;
  tabId?: string;
  onEvent?: BuiltinComponentProps["onEvent"];
}) {
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  if (!target?.entryId || !onEvent || tabIsRunning(state, tabId)) return null;
  return (
    <div
      className="ae-turn-branch-actions"
      onMouseLeave={() => setConfirmingRollback(false)}
    >
      {confirmingRollback ? (
        <>
          <button
            type="button"
            className="ae-turn-branch-btn ae-turn-branch-confirm"
            onClick={() => {
              setConfirmingRollback(false);
              onEvent(
                "rollback-to-here",
                branchEventPayload(target, tabId, state),
              );
            }}
          >
            Confirm rollback
          </button>
          <button
            type="button"
            className="ae-turn-branch-btn"
            onClick={() => setConfirmingRollback(false)}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="ae-turn-branch-btn"
            aria-label="Rollback this turn"
            title="Rewind the conversation to this turn"
            onClick={() => setConfirmingRollback(true)}
          >
            <svg
              viewBox="0 0 16 16"
              width="13"
              height="13"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M5.2 5.1H10a4 4 0 1 1-3.1 6.55" />
              <path d="M5.2 5.1 7.55 2.8" />
              <path d="M5.2 5.1 7.55 7.45" />
            </svg>
            <span className="ae-turn-branch-label">Rollback</span>
          </button>
          <button
            type="button"
            className="ae-turn-branch-btn"
            aria-label="Fork this turn"
            title="Fork the conversation into a new tab from this turn"
            onClick={() =>
              onEvent("fork-to-tab", branchEventPayload(target, tabId, state))
            }
          >
            <svg
              viewBox="0 0 16 16"
              width="13"
              height="13"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M5 3.25v4.15c0 2.4 1.55 4.1 4.2 4.1H11" />
              <path d="M8.75 9.2 11 11.5l-2.25 2.3" />
              <circle cx="5" cy="3.25" r="1.6" />
              <circle cx="5" cy="12.75" r="1.6" />
            </svg>
            <span className="ae-turn-branch-label">Fork</span>
          </button>
        </>
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
  const hasStopNotice = turn.systemMessages.some(
    (message) =>
      message.text?.replace(/\s+/g, " ").trim().toLowerCase() ===
      "agent stopped.",
  );
  const stopped =
    hasStopNotice || (isLatest && !live && state.status === "stopped");
  const interruptedTail =
    !live && hasHiddenThinkingTail(turn, thinkingVisibility);
  const preserveInterruptedProse = stopped || interruptedTail;
  const displayableAgentMessages = turn.agentMessages.filter((message) =>
    hasDisplayableAgentContent(message, thinkingVisibility),
  );
  const visibleFinalMessage = displayableAgentMessages.at(-1);
  const visibleAgentMessages = live
    ? displayableAgentMessages
    : preserveInterruptedProse
      ? displayableAgentMessages
      : visibleFinalMessage
        ? [visibleFinalMessage]
        : turn.progressMessages.filter((message) =>
            hasDisplayableAgentContent(message, thinkingVisibility),
          );
  const visibleAgentMessageIds =
    visibleAgentMessages.length > 0
      ? new Set(visibleAgentMessages.map((message) => message.id))
      : undefined;
  const branchTarget = branchTargetForTurn(turn, visibleAgentMessages);
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
        forceOpen={
          stopped || (interruptedTail && visibleAgentMessages.length === 0)
        }
        visibleAgentMessageIds={visibleAgentMessageIds}
      />
      <TurnBranchActions
        target={branchTarget}
        state={state}
        tabId={tabId}
        onEvent={onEvent}
      />
    </div>
  );
}
