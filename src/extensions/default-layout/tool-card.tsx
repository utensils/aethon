import { useEffect, useMemo, useState } from "react";
import { FileIcon } from "../../components/file-icon";
import type { BooleanValue, NumberValue, StringValue } from "../../types/a2ui";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../utils/dataBinding";
import type {
  SubagentProgress,
  SubagentProgressBatch,
  SubagentProgressEntry,
} from "../../hooks/bridgeMessageHandlers/subagentProgress";
import { Chevron } from "./sidebar/chevron";
import { truncateDiffSnapshotContent } from "../../utils/editorDiffSnapshot";

const TOOL_LONG_RUN_THRESHOLD_MS = 30 * 1000;

interface ToolFileChange {
  kind?: "edited" | "created";
  path?: string;
  rootPath?: string;
  preview?: string;
  additions?: number;
  deletions?: number;
}

/** The tool-card's component id is `tool-<seq>-<callId>`; the subagent progress
 *  slice is keyed by the raw callId, so strip the prefix to look it up. */
function readSubagentProgress(
  state: Record<string, unknown>,
  componentId: string | undefined,
): SubagentProgressEntry | null {
  if (!componentId) return null;
  const callId = componentId.replace(/^tool-\d+-/, "");
  const map = state.subagentProgress as
    | Record<string, SubagentProgressEntry>
    | undefined;
  return map?.[callId] ?? null;
}

function SubagentActivity({ progress }: { progress: SubagentProgress }) {
  return (
    <div className="ae-subagent-activity">
      <div className="ae-subagent-activity-head">
        <span aria-hidden="true">⬡</span> {progress.subagent}
        {progress.model ? ` · ${progress.model}` : ""}
      </div>
      {progress.steps.length > 0 && (
        <ul className="ae-subagent-steps">
          {progress.steps.map((step, i) => (
            <li
              key={i}
              className={
                step.kind === "error" ? "ae-subagent-step-error" : undefined
              }
            >
              {step.label}
            </li>
          ))}
        </ul>
      )}
      {progress.text && (
        <div className="ae-subagent-text" data-done={progress.done}>
          {progress.text}
        </div>
      )}
    </div>
  );
}

function isBatchProgress(
  progress: SubagentProgressEntry,
): progress is SubagentProgressBatch {
  return "kind" in progress && progress.kind === "batch";
}

function SubagentActivityStack({
  progress,
}: {
  progress: SubagentProgressEntry;
}) {
  if (!isBatchProgress(progress)) {
    return <SubagentActivity progress={progress} />;
  }
  return (
    <div className="ae-subagent-activity-stack">
      {progress.order.map((id) => {
        const item = progress.items[id];
        return item ? <SubagentActivity key={id} progress={item} /> : null;
      })}
    </div>
  );
}

export function SubagentResult({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    content?: StringValue;
    isError?: BooleanValue;
  };
  const content = props.content ? resolveString(props.content, state) : "";
  const isError = props.isError ? resolveBoolean(props.isError, state) : false;
  return (
    <div className="ae-subagent-result" data-error={isError ? "true" : "false"}>
      {content}
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- exported for vitest unit tests; doesn't affect HMR semantics in practice
export function formatToolDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

function ToolStatusIcon({
  running,
  isError,
  isCancelled,
  isLongRunning,
}: {
  running: boolean;
  isError: boolean;
  isCancelled: boolean;
  isLongRunning: boolean;
}) {
  if (running) {
    const label = isLongRunning ? "Tool long-running" : "Tool running";
    return (
      <span
        role="img"
        aria-label={label}
        className={`ae-tool-status-icon ae-tool-status-running${isLongRunning ? " ae-tool-status-long" : ""}`}
      >
        <span className="ae-tool-spinner" aria-hidden="true" />
      </span>
    );
  }
  // Completed / failed / cancelled state is conveyed by the card's border
  // colour and the duration label ("Completed"/"Failed in …s"), so no static
  // ✓/✕ glyph is rendered — it was redundant noise on every row.
  void isError;
  void isCancelled;
  return null;
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

/** The expandable body of an edit/write card: the file row (open file /
 *  open diff) plus the inline diff. The "+N -M" stat now lives on the
 *  tool-card summary line, so this renders only when the card is expanded. */
function ToolFileChangeBody({
  change,
  onEvent,
}: {
  change: ToolFileChange;
  onEvent: BuiltinComponentProps["onEvent"];
}) {
  const filePath = typeof change.path === "string" ? change.path : "";
  if (!filePath) return null;
  const fileName = basename(filePath);
  const dir = parentPath(filePath);
  const additions =
    typeof change.additions === "number" && Number.isFinite(change.additions)
      ? change.additions
      : 0;
  const deletions =
    typeof change.deletions === "number" && Number.isFinite(change.deletions)
      ? change.deletions
      : 0;
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
            content: truncateDiffSnapshotContent(capturedDiff),
            ...(additions > 0 ? { additions } : {}),
            ...(deletions > 0 ? { deletions } : {}),
            source: "tool-card",
          },
        }
      : {}),
  };

  return (
    <div className="ae-tool-file-change-body">
      <div className="ae-tool-file-row">
        <button
          type="button"
          className="ae-tool-file-open"
          title={`Open ${filePath}`}
          onClick={() => onEvent("tool-file-open", eventPayload)}
        >
          <FileIcon path={filePath} isDir={false} className="ae-tool-file-icon" />
          <span className="ae-tool-file-name">{fileName}</span>
          {dir ? <span className="ae-tool-file-dir">{dir}</span> : null}
        </button>
        <span className="ae-tool-file-stat" aria-label="Line changes">
          {additions > 0 ? (
            <span className="ae-tool-file-add">+{additions}</span>
          ) : null}
          {deletions > 0 ? (
            <span className="ae-tool-file-del">-{deletions}</span>
          ) : null}
        </span>
        <button
          type="button"
          className="ae-tool-file-diff"
          title={`Open diff for ${filePath}`}
          aria-label={`Open diff for ${fileName}`}
          onClick={() => onEvent("tool-file-diff", eventPayload)}
        >
          ⧉
        </button>
      </div>
      {change.preview ? (
        <pre className="ae-tool-file-diff-preview">
          <code>
            {previewLines(change.preview).map((line, index) => (
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
      ) : (
        <div className="ae-tool-file-no-preview">No inline diff available</div>
      )}
    </div>
  );
}

export function ToolCard({
  component,
  state,
  renderChildren,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    description?: StringValue;
    startedAt?: NumberValue;
    endedAt?: NumberValue;
    isError?: BooleanValue;
    toolName?: StringValue;
    status?: StringValue;
    fileChange?: ToolFileChange;
    filePath?: StringValue;
    rootPath?: StringValue;
    defaultOpen?: BooleanValue;
  };
  const baseTitle = props.title ? resolveString(props.title, state) : "";
  const description = props.description
    ? resolveString(props.description, state)
    : undefined;
  const startedAt = props.startedAt
    ? resolveNumber(props.startedAt, state)
    : undefined;
  const endedAt = props.endedAt
    ? resolveNumber(props.endedAt, state)
    : undefined;
  const isError = props.isError ? resolveBoolean(props.isError, state) : false;
  const toolName = props.toolName ? resolveString(props.toolName, state) : "";
  const subagentProgress =
    toolName === "task" || toolName === "task_batch"
      ? readSubagentProgress(state, component.id)
      : null;
  const status = props.status ? resolveString(props.status, state) : undefined;
  const isCancelled = status === "cancelled";
  const running = startedAt !== undefined && endedAt === undefined;
  // Tool calls are collapsed by default — the card shows only its summary
  // row until the user expands it (or hits "expand all"). Edits keep their
  // file-change summary visible because that lives outside the collapsible
  // body; only the raw output (bash stdout, etc.) hides.
  const [open, setOpen] = useState(false);
  // Respond to the transcript-wide expand/collapse-all broadcast.
  useEffect(() => {
    const onSetAll = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail;
      if (detail && typeof detail.open === "boolean") setOpen(detail.open);
    };
    window.addEventListener("aethon:tool-cards-set-open", onSetAll);
    return () =>
      window.removeEventListener("aethon:tool-cards-set-open", onSetAll);
  }, []);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => window.clearInterval(handle);
  }, [running]);

  const elapsedMs = useMemo(() => {
    if (startedAt === undefined) return 0;
    if (endedAt !== undefined) return Math.max(0, endedAt - startedAt);
    return Math.max(0, now - startedAt);
  }, [startedAt, endedAt, now]);

  const isLongRunning = running && elapsedMs >= TOOL_LONG_RUN_THRESHOLD_MS;
  const hasChildren = (component.children?.length ?? 0) > 0;
  const fileChange =
    props.fileChange && typeof props.fileChange === "object"
      ? props.fileChange
      : undefined;

  const timeSuffix = useMemo(() => {
    if (running) return formatToolDuration(elapsedMs);
    if (startedAt === undefined) return "";
    const duration = formatToolDuration(elapsedMs);
    if (isCancelled) return `Cancelled in ${duration}`;
    if (isError) return `Failed in ${duration}`;
    return `Completed in ${duration}`;
  }, [running, startedAt, elapsedMs, isCancelled, isError]);

  // A successful `read` renders as a single clickable filename (opens in the
  // Monaco editor) — no file-content dump. The path is taken from the
  // explicit `filePath` prop when present, else parsed out of the legacy
  // description ("<path> lines N-M") for older restored sessions.
  const readFilePath = props.filePath ? resolveString(props.filePath, state) : "";
  const readRootPath = props.rootPath ? resolveString(props.rootPath, state) : "";
  const openPath =
    readFilePath || (description ?? "").replace(/\s+lines\s+\S.*$/, "");
  if (toolName === "read" && !isError && openPath) {
    return (
      <div className="ae-tool-card ae-tool-card-read">
        <div className="ae-tool-card-summary">
          <ToolStatusIcon
            running={running}
            isError={isError}
            isCancelled={isCancelled}
            isLongRunning={isLongRunning}
          />
          <span className="ae-tool-card-name">{baseTitle}</span>
          <button
            type="button"
            className="ae-tool-card-read-path"
            title={`Open ${openPath}`}
            onClick={() =>
              onEvent("tool-file-open", {
                filePath: openPath,
                ...(readRootPath ? { rootPath: readRootPath } : {}),
              })
            }
          >
            {description || openPath}
          </button>
          {timeSuffix && <span className="ae-tool-card-time">{timeSuffix}</span>}
        </div>
      </div>
    );
  }

  const hasFileChange = Boolean(fileChange);
  const hasRawOutput = hasChildren && !hasFileChange;
  // Every card collapses to one line. Edits/writes expand to their diff;
  // bash and friends expand to their stdout; subagents to their activity.
  const hasExpandableBody =
    hasFileChange || hasRawOutput || Boolean(subagentProgress);
  const fileAdds =
    fileChange && typeof fileChange.additions === "number"
      ? fileChange.additions
      : 0;
  const fileDels =
    fileChange && typeof fileChange.deletions === "number"
      ? fileChange.deletions
      : 0;
  const summaryInner = (
    <>
      <ToolStatusIcon
        running={running}
        isError={isError}
        isCancelled={isCancelled}
        isLongRunning={isLongRunning}
      />
      <span className="ae-tool-card-name">{baseTitle}</span>
      {description && (
        <span className="ae-tool-card-description">{description}</span>
      )}
      {hasFileChange && (fileAdds > 0 || fileDels > 0) && (
        <span className="ae-tool-card-diffstat" aria-label="Line changes">
          {fileAdds > 0 ? (
            <span className="ae-tool-file-add">+{fileAdds}</span>
          ) : null}
          {fileDels > 0 ? (
            <span className="ae-tool-file-del">-{fileDels}</span>
          ) : null}
        </span>
      )}
      {timeSuffix && <span className="ae-tool-card-time">{timeSuffix}</span>}
      {isLongRunning && (
        <span className="ae-tool-card-long-hint">
          long-running · <kbd>⌘.</kbd> to stop
        </span>
      )}
    </>
  );

  return (
    <div
      className="ae-tool-card"
      data-open={open ? "true" : "false"}
      data-collapsible={hasExpandableBody ? "true" : "false"}
      data-running={running ? "true" : "false"}
      data-long-running={isLongRunning ? "true" : "false"}
      data-error={isError ? "true" : "false"}
      data-cancelled={isCancelled ? "true" : "false"}
    >
      {hasExpandableBody ? (
        <button
          type="button"
          className="ae-tool-card-summary"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span className="ae-tool-card-disclosure" aria-hidden="true">
            <Chevron expanded={open} size={12} />
          </span>
          {summaryInner}
        </button>
      ) : (
        <div className="ae-tool-card-summary ae-tool-card-summary-static">
          {summaryInner}
        </div>
      )}
      {hasExpandableBody && open && (
        <div className="ae-tool-card-body">
          {subagentProgress && (
            <SubagentActivityStack progress={subagentProgress} />
          )}
          {hasFileChange && fileChange ? (
            <ToolFileChangeBody change={fileChange} onEvent={onEvent} />
          ) : hasRawOutput ? (
            renderChildren?.()
          ) : null}
        </div>
      )}
    </div>
  );
}
