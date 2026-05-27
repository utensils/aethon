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

export function StatusBar({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    left?: StringValue;
    center?: StringValue;
    right?: StringValue;
    /** Optional segments rendered between `left` and `center`. Each is
     *  a small chip carrying project / worktree / branch context.
     *  Resolved by reading the active project + active worktree from
     *  /sidebar/projects. */
    showProjectChip?: boolean;
  };

  const left = props.left ? resolveString(props.left, state) : "";
  const center = props.center ? resolveString(props.center, state) : "";
  const right = props.right ? resolveString(props.right, state) : "";

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
              {active.git.dirty ? (
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
