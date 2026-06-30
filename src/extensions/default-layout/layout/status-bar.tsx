/**
 * `StatusBar` — three-region status footer (left/center/right) with an
 * optional project/workspace/branch chip wedged between `left` and
 * `center`, plus a devshell chip after it. Both chips read from
 * central state, never from a local fetch — the sidebar feeds the
 * project chip and the `useDevshell` hook feeds the devshell chip.
 */

import { resolvePointer } from "../../../utils/jsonPointer";
import { resolveString } from "../../../utils/dataBinding";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { StringValue } from "../../../types/a2ui";
import type { DevshellEntry } from "../../../hooks/useDevshell";
import type { ContextUsageState } from "../../../types/tab";
import {
  agentActivityForTab,
  useDelayedAgentActivity,
} from "../../../agentActivity";

export function StatusBar({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    left?: StringValue;
    center?: StringValue;
    right?: StringValue;
    context?: { $ref: string };
    /** Optional segments rendered between `left` and `center`. Each is
     *  a small chip carrying project / workspace / branch context.
     *  Resolved by reading the active project + active workspace from
     *  /sidebar/projects. */
    showProjectChip?: boolean;
  };

  const left = props.left ? resolveString(props.left, state) : "";
  const center = props.center ? resolveString(props.center, state) : "";
  const right = props.right ? resolveString(props.right, state) : "";
  const contextUsage = props.context
    ? contextUsageFromValue(resolveValue(state, props.context.$ref))
    : null;
  const visibleAgentActivity = useDelayedAgentActivity(
    agentActivityForTab(state),
  );
  const genericAgentActivity =
    !visibleAgentActivity && state.waiting === true
      ? {
          label: "Thinking through next step",
          detail: "Waiting for the next update",
        }
      : null;
  const statusAgentActivity = visibleAgentActivity ?? genericAgentActivity;
  const centerStatus = statusAgentActivity ?? {
    label: idleStatusLabel(left, center),
    detail: idleStatusDetail(left, center),
  };
  const leftLabel = center || "disconnected";
  const leftTitle = leftLabel;
  const leftConnectionState = connectionStateClass(leftLabel);
  const leftClassName = `a2ui-status-left ${leftConnectionState}`;
  const centerClassName = `a2ui-status-center${
    statusAgentActivity ? " is-agent-active" : ""
  }`;

  // Project / workspace / branch chip — derived from the live sidebar
  // projects list so a single source of truth drives both the sidebar
  // and the status bar. No-op when no project is active.
  type SidebarProj = {
    id: string;
    label?: string;
    active?: boolean;
    tooltip?: string;
    git?: { branch?: string; dirty?: boolean; ahead?: number; behind?: number };
    workspaces?: Array<{
      id: string;
      label?: string;
      branch?: string;
      active?: boolean;
    }>;
  };
  const projects =
    (resolveValue(state, "/sidebar/projects") as SidebarProj[] | undefined) ??
    [];
  const activeProjectId = resolveValue(state, "/activeProjectId");
  const active =
    (typeof activeProjectId === "string"
      ? projects.find((p) => p.id === activeProjectId)
      : undefined) ?? projects.find((p) => p.active === true);
  const activeWt = active?.workspaces?.find((w) => w.active === true);
  const showChip = props.showProjectChip !== false && !!active;

  // Working-tree change count from the /vcs slice (populated by
  // useVcsStatus for the active project/workspace). Shown in the chip in
  // place of the bare dirty dot so the footer carries a real signal.
  const vcs = resolveValue(state, "/vcs") as
    | { changes?: { total?: number } }
    | undefined;
  const changeCount =
    typeof vcs?.changes?.total === "number" ? vcs.changes.total : 0;

  // Devshell chip data — read from `/devshell/{activeRoot, entries}`
  // populated by the useDevshell hook. Same single-source-of-truth
  // discipline as the project chip above.
  const devshellSlice = resolveValue(state, "/devshell") as
    | { activeRoot?: string | null; entries?: Record<string, DevshellEntry> }
    | undefined;
  const devshellRoot = devshellSlice?.activeRoot ?? null;
  const devshellEntry: DevshellEntry | undefined =
    devshellRoot && devshellSlice?.entries
      ? devshellSlice.entries[devshellRoot]
      : undefined;
  const devshellLabel = devshellEntry ? devshellChipLabel(devshellEntry) : null;
  const devshellTooltip = devshellEntry
    ? devshellChipTooltip(devshellEntry)
    : null;
  const devshellClass = devshellEntry
    ? `a2ui-status-devshell-chip is-${devshellEntry.state}`
    : "a2ui-status-devshell-chip";
  const startupSlice = resolveValue(state, "/workspaceStartup") as
    | {
        activeRoot?: string | null;
        entries?: Record<string, { state?: string; reason?: string | null }>;
      }
    | undefined;
  const startupRoot = startupSlice?.activeRoot ?? null;
  const startupEntry =
    startupRoot && startupSlice?.entries
      ? startupSlice.entries[startupRoot]
      : null;
  const startupLabel = startupEntry
    ? startupChipLabel(startupEntry.state)
    : null;

  return (
    <footer className="a2ui-status-bar">
      <span className={leftClassName} title={leftTitle}>
        {leftLabel}
      </span>
      {showChip ? (
        <span
          className="a2ui-status-project-chip"
          title={active?.tooltip ?? active?.label ?? ""}
        >
          <span className="a2ui-status-chip-dot" />
          <span className="a2ui-status-chip-label">{active?.label}</span>
          {activeWt ? (
            <>
              <span className="a2ui-status-chip-sep">/</span>
              <span className="a2ui-status-chip-workspace">
                {activeWt.label || activeWt.branch}
              </span>
            </>
          ) : active?.git?.branch ? (
            <>
              <span className="a2ui-status-chip-sep">·</span>
              <span className="a2ui-status-chip-branch">
                {active.git.branch}
              </span>
              {changeCount > 0 ? (
                <span
                  className="a2ui-status-chip-changes"
                  title={`${changeCount} changed file${changeCount === 1 ? "" : "s"}`}
                >
                  {changeCount}±
                </span>
              ) : active.git.dirty ? (
                <span className="a2ui-status-chip-dirty" title="dirty">
                  •
                </span>
              ) : null}
            </>
          ) : null}
        </span>
      ) : null}
      {devshellLabel ? (
        <span className={devshellClass} title={devshellTooltip ?? undefined}>
          <span className="a2ui-status-devshell-icon" aria-hidden="true">
            ⬡
          </span>
          <span className="a2ui-status-devshell-label">{devshellLabel}</span>
        </span>
      ) : null}
      {startupLabel ? (
        <span
          className={`a2ui-status-startup-chip is-${startupEntry?.state ?? "idle"}`}
          title={startupEntry?.reason ?? undefined}
        >
          <span className="a2ui-status-startup-dot" aria-hidden="true" />
          <span className="a2ui-status-startup-label">{startupLabel}</span>
        </span>
      ) : null}
      {contextUsage ? <ContextMeter usage={contextUsage} /> : null}
      <span
        className={centerClassName}
        title={centerStatus.detail ?? centerStatus.label}
      >
        <span className="a2ui-status-center-main">{centerStatus.label}</span>
        {centerStatus.detail ? (
          <span className="a2ui-status-center-detail">
            {centerStatus.detail}
          </span>
        ) : null}
      </span>
      <span className="a2ui-status-right">{right}</span>
    </footer>
  );
}

function idleStatusLabel(status: string, connection: string): string {
  const normalizedStatus = status.trim().toLowerCase();
  const normalizedConnection = connection.trim().toLowerCase();
  if (
    normalizedStatus === "ready" ||
    normalizedStatus === "idle" ||
    normalizedConnection === "connected"
  ) {
    return "idle";
  }
  return status || normalizedConnection || "idle";
}

function idleStatusDetail(
  status: string,
  connection: string,
): string | undefined {
  const normalizedStatus = status.trim().toLowerCase();
  const normalizedConnection = connection.trim().toLowerCase();
  if (
    normalizedStatus === "ready" ||
    normalizedStatus === "idle" ||
    normalizedConnection === "connected"
  ) {
    return undefined;
  }
  return connection || undefined;
}

function connectionStateClass(connection: string): string {
  switch (connection.trim().toLowerCase()) {
    case "connected":
      return "is-connected";
    case "connecting":
    case "starting":
    case "starting…":
      return "is-connecting";
    default:
      return "is-disconnected";
  }
}

function startupChipLabel(state: string | undefined): string | null {
  switch (state) {
    case "running":
      return "startup running";
    case "approval_required":
      return "startup approval";
    case "failed":
      return "startup failed";
    default:
      return null;
  }
}

/** Read a state pointer for non-string values (resolveString coerces). */
function resolveValue(state: unknown, ptr: string): unknown {
  try {
    return resolvePointer(state as Record<string, unknown>, ptr);
  } catch {
    return undefined;
  }
}

function devshellChipLabel(entry: DevshellEntry): string | null {
  switch (entry.state) {
    case "resolving":
      return `${entry.kind ?? "devshell"} · resolving…`;
    case "ready":
      return entry.kind ?? "devshell";
    case "failed":
      return `${entry.kind ?? "devshell"} · failed`;
    case "idle":
      // Detected but not yet resolved — show the kind so the user
      // sees we noticed the flake.
      if (entry.enabled === "never") return `${entry.kind ?? "devshell"} · off`;
      return entry.kind ?? "devshell";
    case "none":
      if (entry.enabled === "never" && entry.detectedKind) {
        return `${entry.detectedKind} · off`;
      }
      return null;
    default:
      return null;
  }
}

function devshellChipTooltip(entry: DevshellEntry): string | null {
  const lines: string[] = [];
  if (entry.detectedKind) {
    lines.push(`Devshell kind: ${entry.detectedKind}`);
  }
  lines.push(`Config: enabled=${entry.enabled}, mode=${entry.mode}`);
  switch (entry.state) {
    case "ready":
      if (entry.varCount !== undefined) {
        lines.push(`${entry.varCount} environment variables applied`);
      }
      if (entry.durationMs !== undefined) {
        lines.push(`Resolved in ${entry.durationMs} ms`);
      }
      break;
    case "resolving":
      lines.push("Resolver running — new shells wait for the dev env");
      break;
    case "failed":
      if (entry.reason) lines.push(`Error: ${entry.reason}`);
      break;
    case "none":
      if (entry.enabled === "never") {
        lines.push(
          'Devshell disabled in config — set [devshell] enabled = "auto" to re-enable',
        );
      }
      break;
  }
  return lines.join("\n");
}

function contextUsageFromValue(value: unknown): ContextUsageState | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Partial<ContextUsageState>;
  if (
    typeof usage.contextWindow !== "number" ||
    !Number.isFinite(usage.contextWindow) ||
    usage.contextWindow <= 0
  ) {
    return null;
  }
  const tokens = finiteNumberOrNull(usage.tokens);
  const estimatedTokens = finiteNumberOrNull(usage.estimatedTokens) ?? tokens;
  const transientTokens = finiteNumberOrNull(usage.transientTokens) ?? 0;
  const saturatedByProvider =
    usage.saturatedByProvider === true || usage.saturated === true;
  return {
    model: typeof usage.model === "string" ? usage.model : "",
    status: usage.status === "known" ? "known" : "unknown",
    tokens,
    contextWindow: usage.contextWindow,
    percent: finiteNumberOrNull(usage.percent),
    estimatedTokens,
    estimatedPercent: finiteNumberOrNull(usage.estimatedPercent),
    transientTokens,
    autoCompactEnabled: usage.autoCompactEnabled === true,
    reserveTokens: finiteNumberOrNull(usage.reserveTokens) ?? 0,
    compactAtTokens:
      finiteNumberOrNull(usage.compactAtTokens) ?? usage.contextWindow,
    tokensUntilCompact: finiteNumberOrNull(usage.tokensUntilCompact),
    estimatedTokensUntilCompact: finiteNumberOrNull(
      usage.estimatedTokensUntilCompact,
    ),
    ...(usage.compacting === true ? { compacting: true } : {}),
    ...(saturatedByProvider
      ? { saturatedByProvider: true, saturated: true }
      : {}),
    ...(usage.saturatedByEstimate === true
      ? { saturatedByEstimate: true }
      : {}),
  };
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  if (value < 1000) return value.toLocaleString("en-US");
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function formatExactTokens(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : "unknown";
}

function formatEstimatedTokens(
  value: number | null | undefined,
  contextWindow: number,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  return value >= contextWindow
    ? `${formatTokens(contextWindow)}+`
    : formatTokens(value);
}

function ContextMeter({ usage }: { usage: ContextUsageState }) {
  const providerPercent =
    usage.percent ??
    (usage.tokens !== null ? (usage.tokens / usage.contextWindow) * 100 : null);
  const estimatedPercent =
    usage.estimatedPercent ??
    (usage.estimatedTokens !== null
      ? (usage.estimatedTokens / usage.contextWindow) * 100
      : null);
  const saturatedByProvider = usage.saturatedByProvider || usage.saturated;
  const estimateActive =
    usage.transientTokens > 0 &&
    usage.tokens !== null &&
    usage.estimatedTokens !== null &&
    usage.estimatedTokens > usage.tokens;
  const estimateOverCompact =
    estimateActive &&
    usage.autoCompactEnabled &&
    usage.estimatedTokens !== null &&
    usage.estimatedTokens >= usage.compactAtTokens &&
    (usage.tokens === null || usage.tokens < usage.compactAtTokens);
  const saturatedByEstimate =
    usage.saturatedByEstimate ||
    (estimateActive &&
      !saturatedByProvider &&
      usage.estimatedTokens !== null &&
      usage.estimatedTokens >= usage.contextWindow);
  const usageClass = saturatedByProvider
    ? " is-danger"
    : providerPercent !== null && providerPercent >= 90
      ? " is-danger"
      : estimateOverCompact ||
          (providerPercent !== null && providerPercent >= 70)
        ? " is-warning"
        : "";
  const saturatedClass = saturatedByProvider ? " is-saturated" : "";
  const estimatedClass = estimateOverCompact ? " is-estimated-over" : "";
  const compactingClass = usage.compacting ? " is-compacting" : "";
  const percentLabel = saturatedByProvider
    ? "FULL"
    : providerPercent === null
      ? "?"
      : `${Math.round(providerPercent)}%`;
  const usedLabel =
    usage.tokens === null
      ? `?/${formatTokens(usage.contextWindow)}`
      : `${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`;
  const estimateLabel = estimateActive
    ? `est ${formatEstimatedTokens(usage.estimatedTokens, usage.contextWindow)}`
    : null;
  const pendingLabel = estimateOverCompact ? "pending turn" : null;
  const autoLabel = usage.autoCompactEnabled
    ? `auto @${formatTokens(usage.compactAtTokens)}`
    : "auto off";
  const title = [
    usage.model ? `Model: ${usage.model}` : null,
    `Context used: ${formatExactTokens(usage.tokens)} of ${formatExactTokens(
      usage.contextWindow,
    )} tokens`,
    providerPercent === null
      ? "Provider usage is unknown until the next assistant response."
      : `Provider usage: ${providerPercent.toFixed(1)}%`,
    estimateActive
      ? `Live estimate including current turn/tool output: ${formatExactTokens(
          usage.estimatedTokens,
        )} of ${formatExactTokens(usage.contextWindow)} tokens${
          estimatedPercent === null ? "" : ` (${estimatedPercent.toFixed(1)}%)`
        }`
      : null,
    estimateOverCompact
      ? "Tool output estimate exceeds the auto-compact threshold; compaction is pending the current turn/model response or overflow recovery."
      : null,
    usage.autoCompactEnabled
      ? `Next auto compaction: ${formatExactTokens(
          usage.compactAtTokens,
        )} provider tokens (${formatExactTokens(
          usage.tokensUntilCompact,
        )} provider tokens remaining)`
      : "Auto compaction: off",
    `Reserve: ${formatExactTokens(usage.reserveTokens)} tokens`,
    saturatedByProvider
      ? "Context full — older turns are being truncated (silent, lossy). Run /compact or /clear."
      : null,
    saturatedByEstimate
      ? "The live estimate has reached the context window, but provider usage has not; this is not an auto-compaction failure."
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      className={`a2ui-status-context-chip${usageClass}${saturatedClass}${estimatedClass}${compactingClass}`}
      title={title}
      aria-label={
        saturatedByProvider
          ? "Context full, truncating"
          : estimateOverCompact
            ? `Context ${percentLabel}, tool-output estimate pending compaction`
            : `Context ${percentLabel}`
      }
    >
      <span className="a2ui-status-context-track" aria-hidden="true">
        <span
          className="a2ui-status-context-fill"
          style={{
            width: `${Math.max(0, Math.min(providerPercent ?? 0, 100))}%`,
          }}
        />
      </span>
      <span className="a2ui-status-context-label">ctx {percentLabel}</span>
      <span className="a2ui-status-context-detail">{usedLabel}</span>
      {estimateLabel ? (
        <span className="a2ui-status-context-estimate">{estimateLabel}</span>
      ) : null}
      {pendingLabel ? (
        <span className="a2ui-status-context-pending">{pendingLabel}</span>
      ) : null}
      <span className="a2ui-status-context-auto">{autoLabel}</span>
    </span>
  );
}
