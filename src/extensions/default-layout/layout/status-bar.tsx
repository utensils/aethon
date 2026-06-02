/**
 * `StatusBar` — three-region status footer (left/center/right) with an
 * optional project/worktree/branch chip wedged between `left` and
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

export function StatusBar({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    left?: StringValue;
    center?: StringValue;
    right?: StringValue;
    context?: { $ref: string };
    /** Optional segments rendered between `left` and `center`. Each is
     *  a small chip carrying project / worktree / branch context.
     *  Resolved by reading the active project + active worktree from
     *  /sidebar/projects. */
    showProjectChip?: boolean;
  };

  const left = props.left ? resolveString(props.left, state) : "";
  const center = props.center ? resolveString(props.center, state) : "";
  const right = props.right ? resolveString(props.right, state) : "";
  const contextUsage = props.context
    ? contextUsageFromValue(resolveValue(state, props.context.$ref))
    : null;

  // Project / worktree / branch chip — derived from the live sidebar
  // projects list so a single source of truth drives both the sidebar
  // and the status bar. No-op when no project is active.
  type SidebarProj = {
    id: string;
    label?: string;
    active?: boolean;
    tooltip?: string;
    git?: { branch?: string; dirty?: boolean; ahead?: number; behind?: number };
    worktrees?: Array<{
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
  const activeWt = active?.worktrees?.find((w) => w.active === true);
  const showChip = props.showProjectChip !== false && !!active;

  // Working-tree change count from the /vcs slice (populated by
  // useVcsStatus for the active project/worktree). Shown in the chip in
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
  const devshellTooltip = devshellEntry ? devshellChipTooltip(devshellEntry) : null;
  const devshellClass = devshellEntry
    ? `a2ui-status-devshell-chip is-${devshellEntry.state}`
    : "a2ui-status-devshell-chip";

  return (
    <footer className="a2ui-status-bar">
      <span className="a2ui-status-left">{left}</span>
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
              <span className="a2ui-status-chip-worktree">
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
      {contextUsage ? <ContextMeter usage={contextUsage} /> : null}
      <span className="a2ui-status-center">{center}</span>
      <span className="a2ui-status-right">{right}</span>
    </footer>
  );
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
      lines.push("Resolver running — first shell may use host env");
      break;
    case "failed":
      if (entry.reason) lines.push(`Error: ${entry.reason}`);
      break;
    case "none":
      if (entry.enabled === "never") {
        lines.push("Devshell disabled in config — set [devshell] enabled = \"auto\" to re-enable");
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
  return {
    model: typeof usage.model === "string" ? usage.model : "",
    status: usage.status === "known" ? "known" : "unknown",
    tokens: finiteNumberOrNull(usage.tokens),
    contextWindow: usage.contextWindow,
    percent: finiteNumberOrNull(usage.percent),
    autoCompactEnabled: usage.autoCompactEnabled === true,
    reserveTokens: finiteNumberOrNull(usage.reserveTokens) ?? 0,
    compactAtTokens:
      finiteNumberOrNull(usage.compactAtTokens) ?? usage.contextWindow,
    tokensUntilCompact: finiteNumberOrNull(usage.tokensUntilCompact),
    ...(usage.compacting === true ? { compacting: true } : {}),
    ...(usage.saturated === true ? { saturated: true } : {}),
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

function ContextMeter({ usage }: { usage: ContextUsageState }) {
  const percentValue =
    usage.percent ??
    (usage.tokens !== null ? (usage.tokens / usage.contextWindow) * 100 : null);
  const usageClass =
    usage.saturated || (percentValue !== null && percentValue >= 90)
      ? " is-danger"
      : percentValue !== null && percentValue >= 70
        ? " is-warning"
        : "";
  const saturatedClass = usage.saturated ? " is-saturated" : "";
  const compactingClass = usage.compacting ? " is-compacting" : "";
  const percentLabel = usage.saturated
    ? "FULL"
    : percentValue === null
      ? "?"
      : `${Math.round(percentValue)}%`;
  const usedLabel =
    usage.tokens === null
      ? `?/${formatTokens(usage.contextWindow)}`
      : `${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`;
  const autoLabel = usage.autoCompactEnabled
    ? `auto @${formatTokens(usage.compactAtTokens)}`
    : "auto off";
  const title = [
    usage.model ? `Model: ${usage.model}` : null,
    `Context used: ${formatExactTokens(usage.tokens)} of ${formatExactTokens(
      usage.contextWindow,
    )} tokens`,
    usage.percent === null
      ? "Usage is unknown until the next assistant response."
      : `Usage: ${usage.percent.toFixed(1)}%`,
    usage.autoCompactEnabled
      ? `Next auto compaction: ${formatExactTokens(
          usage.compactAtTokens,
        )} tokens (${formatExactTokens(usage.tokensUntilCompact)} remaining)`
      : "Auto compaction: off",
    `Reserve: ${formatExactTokens(usage.reserveTokens)} tokens`,
    usage.saturated
      ? "Context full — older turns are being truncated (silent, lossy). Run /compact or /clear."
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      className={`a2ui-status-context-chip${usageClass}${saturatedClass}${compactingClass}`}
      title={title}
      aria-label={
        usage.saturated ? "Context full, truncating" : `Context ${percentLabel}`
      }
    >
      <span className="a2ui-status-context-track" aria-hidden="true">
        <span
          className="a2ui-status-context-fill"
          style={{ width: `${Math.max(0, Math.min(percentValue ?? 0, 100))}%` }}
        />
      </span>
      <span className="a2ui-status-context-label">ctx {percentLabel}</span>
      <span className="a2ui-status-context-detail">{usedLabel}</span>
      <span className="a2ui-status-context-auto">{autoLabel}</span>
    </span>
  );
}
