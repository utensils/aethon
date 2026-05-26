/**
 * `StatusBar` — three-region status footer (left/center/right) with an
 * optional project/worktree/branch chip wedged between `left` and
 * `center`. The chip reads from `/sidebar/projects` + `/activeProjectId`
 * so the sidebar is the single source of truth — the bar doesn't fetch
 * git state itself.
 */

import { resolvePointer } from "../../../utils/jsonPointer";
import { resolveString } from "../../../utils/dataBinding";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { StringValue } from "../../../types/a2ui";

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
