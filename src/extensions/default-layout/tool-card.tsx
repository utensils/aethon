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
  if (isError || isCancelled) {
    const className = isCancelled
      ? "ae-tool-status-icon ae-tool-status-cancelled"
      : "ae-tool-status-icon ae-tool-status-error";
    return (
      <span
        role="img"
        aria-label={isCancelled ? "Tool cancelled" : "Tool failed"}
        className={className}
      >
        <span aria-hidden="true">✕</span>
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label="Tool completed"
      className="ae-tool-status-icon ae-tool-status-done"
    >
      <span aria-hidden="true">✓</span>
    </span>
  );
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

function ToolFileChangePreview({
  change,
  onEvent,
}: {
  change: ToolFileChange;
  onEvent: BuiltinComponentProps["onEvent"];
}) {
  const [open, setOpen] = useState(false);
  const filePath = typeof change.path === "string" ? change.path : "";
  if (!filePath) return null;
  const kind = change.kind === "created" ? "created" : "edited";
  const label = kind === "created" ? "Created 1 file" : "Edited 1 file";
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
  const eventPayload = {
    filePath,
    ...(change.rootPath ? { rootPath: change.rootPath } : {}),
  };

  return (
    <details
      className="ae-tool-file-change"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="ae-tool-file-change-summary">
        <span className="ae-tool-file-change-chevron" aria-hidden="true">
          <Chevron expanded={open} />
        </span>
        <span className="ae-tool-file-change-icon" aria-hidden="true">
          ✎
        </span>
        <span className="ae-tool-file-change-label">{label}</span>
      </summary>
      <div className="ae-tool-file-change-body">
        <div className="ae-tool-file-row">
          <button
            type="button"
            className="ae-tool-file-open"
            title={`Open ${filePath}`}
            onClick={() => onEvent("tool-file-open", eventPayload)}
          >
            <FileIcon
              path={filePath}
              isDir={false}
              className="ae-tool-file-icon"
            />
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
          <div className="ae-tool-file-no-preview">
            No inline diff available
          </div>
        )}
      </div>
    </details>
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

  return (
    <details
      className="ae-tool-card"
      data-running={running ? "true" : "false"}
      data-long-running={isLongRunning ? "true" : "false"}
      data-error={isError ? "true" : "false"}
      data-cancelled={isCancelled ? "true" : "false"}
    >
      <summary className="ae-tool-card-summary">
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
        {timeSuffix && <span className="ae-tool-card-time">{timeSuffix}</span>}
        {isLongRunning && (
          <span className="ae-tool-card-long-hint">
            long-running · <kbd>⌘.</kbd> to stop
          </span>
        )}
      </summary>
      <div className="ae-tool-card-body">
        {subagentProgress && (
          <SubagentActivityStack progress={subagentProgress} />
        )}
        {fileChange && (
          <ToolFileChangePreview change={fileChange} onEvent={onEvent} />
        )}
        {hasChildren && !fileChange?.preview ? renderChildren?.() : null}
        {!hasChildren && !fileChange && !subagentProgress ? (
          <div className="ae-tool-card-empty">No output</div>
        ) : null}
      </div>
    </details>
  );
}
