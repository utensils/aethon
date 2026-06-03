import { useEffect, useMemo, useState } from "react";
import type {
  BooleanValue,
  NumberValue,
  StringValue,
} from "../../types/a2ui";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../utils/dataBinding";
import type { SubagentProgress } from "../../hooks/bridgeMessageHandlers/subagentProgress";

const TOOL_LONG_RUN_THRESHOLD_MS = 30 * 1000;

/** The tool-card's component id is `tool-<seq>-<callId>`; the subagent progress
 *  slice is keyed by the raw callId, so strip the prefix to look it up. */
function readSubagentProgress(
  state: Record<string, unknown>,
  componentId: string | undefined,
): SubagentProgress | null {
  if (!componentId) return null;
  const callId = componentId.replace(/^tool-\d+-/, "");
  const map = state.subagentProgress as
    | Record<string, SubagentProgress>
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
      {!progress.done && progress.text && (
        <div className="ae-subagent-text">{progress.text}</div>
      )}
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

export function ToolCard({
  component,
  state,
  renderChildren,
}: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    description?: StringValue;
    startedAt?: NumberValue;
    endedAt?: NumberValue;
    isError?: BooleanValue;
    toolName?: StringValue;
    status?: StringValue;
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
    toolName === "task" ? readSubagentProgress(state, component.id) : null;
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
        {subagentProgress && <SubagentActivity progress={subagentProgress} />}
        {hasChildren ? (
          renderChildren?.()
        ) : subagentProgress ? null : (
          <div className="ae-tool-card-empty">No output</div>
        )}
      </div>
    </details>
  );
}
