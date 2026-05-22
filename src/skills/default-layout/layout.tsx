/**
 * Layout primitives for the default-layout skill — the CSS-grid `Layout`
 * container, the inline Æπ brand monogram, the `--app-ui-scale` reader,
 * plus the small chrome composites that share the same root semantics
 * (`StatusBar`, `EmptyState`).
 */

import { resolvePointer } from "../../utils/jsonPointer";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../utils/dataBinding";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import type { BooleanValue, NumberValue, StringValue } from "../../types/a2ui";
import type { CSSProperties } from "react";

// eslint-disable-next-line react-refresh/only-export-components -- helper used by sibling chat module; doesn't affect HMR in practice
export function readUiScale(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--app-ui-scale")
    .trim();
  const scale = parseFloat(raw || "1");
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

// Inline Æπ monogram — used by Sidebar / TabRail / etc. without going
// through the A2UI registry (so brand-chrome inside a composite doesn't
// require a payload to declare an `ae-mark` child).
export function AeMarkInline({
  size = 20,
  radius = 4,
}: {
  size?: number;
  radius?: number;
}) {
  return (
    <svg
      className="ae-mark"
      width={size}
      height={size}
      viewBox="0 0 320 320"
      role="img"
      aria-label="Aethon"
      style={{ display: "block", borderRadius: radius, flexShrink: 0 }}
    >
      <title>Aethon</title>
      <rect width="320" height="320" rx="60" fill="var(--bg-elev, #1f1f23)" />
      <text
        x="152"
        y="160"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily='"Playfair Display", "Bodoni 72", Didot, Georgia, serif'
        fontSize="236"
        fontWeight={700}
        fill="var(--text, #fef3e2)"
      >
        Æ
      </text>
      <circle
        cx="248"
        cy="82"
        r="38"
        fill="var(--accent, #ff6a18)"
        opacity="0.85"
      />
      <text
        x="248"
        y="86"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily='"Playfair Display", Didot, Georgia, serif'
        fontSize="44"
        fontWeight={700}
        fontStyle="italic"
        fill="var(--text, #fef3e2)"
      >
        π
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Layout — CSS Grid container with template-areas. Children opt into a region
// by setting their own `area` prop; the layout reads it and wraps the child
// in a div with `grid-area: <area>`.
// ---------------------------------------------------------------------------

export function Layout({
  component,
  state,
  renderChild,
}: BuiltinComponentProps) {
  const props = component.props as {
    columns?: StringValue;
    rows?: StringValue;
    // Inline array OR $ref to a state-bound array. Bound form lets the
    // grid template-areas swap reactively when the user toggles a layout
    // option (e.g. show/hide the sidebar) without requiring a full
    // setLayout replacement.
    areas?: string[] | { $ref: string };
    gap?: NumberValue;
    // Optional slot → grid-area remap. By default a child's `slot` prop
    // resolves to a grid area of the same name; this map lets a layout
    // host the standard composites under non-canonical area names. See
    // `./slots.json` for the canonical slot list.
    slotMap?: Record<string, string>;
  };

  const columns = props.columns
    ? resolveString(props.columns, state)
    : "minmax(0,1fr)";
  const rows = props.rows ? resolveString(props.rows, state) : "minmax(0,1fr)";
  const gap = props.gap ? resolveNumber(props.gap, state) : 0;
  const resolvedAreas = (() => {
    const a = props.areas;
    if (!a) return undefined;
    if (Array.isArray(a)) return a;
    if (typeof a === "object" && "$ref" in a) {
      const v = resolvePointer(state, a.$ref);
      return Array.isArray(v) ? (v as string[]) : undefined;
    }
    return undefined;
  })();
  const areas = resolvedAreas
    ? resolvedAreas.map((row) => `"${row}"`).join(" ")
    : undefined;
  const slotMap = props.slotMap ?? {};

  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: columns,
    gridTemplateRows: rows,
    gridTemplateAreas: areas,
    gap: `${gap}px`,
    height: "100%",
    width: "100%",
    minHeight: 0,
    transition: "grid-template-columns 180ms ease",
  };

  return (
    <div className="a2ui-layout" style={style}>
      {component.children?.map((child) => {
        const childProps = child.props as
          | { area?: string; visible?: BooleanValue }
          | undefined;
        // The child's `area` prop doubles as the slot name. By default the
        // slot name IS the CSS grid area; an optional slotMap on the root
        // layout lets a non-canonical layout host the standard composites
        // under a different grid area name (e.g. slotMap.composer = "bottom").
        // See `./slots.json` for the canonical slot list.
        const slotName = childProps?.area;
        const area = slotName ? (slotMap[slotName] ?? slotName) : undefined;
        const visible =
          childProps?.visible === undefined
            ? true
            : resolveBoolean(childProps.visible, state);
        const cellStyle: CSSProperties = {
          gridArea: area,
          minWidth: 0,
          minHeight: 0,
          display: visible ? "flex" : "none",
        };
        return (
          <div key={child.id} className="a2ui-layout-cell" style={cellStyle}>
            {renderChild?.(child)}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusBar — three-region status footer (left/center/right).
// ---------------------------------------------------------------------------

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
    worktrees?: Array<{ id: string; label?: string; branch?: string; active?: boolean }>;
  };
  const projects =
    (resolveValue(state, "/sidebar/projects") as SidebarProj[] | undefined) ?? [];
  const active = projects.find((p) => p.active === true);
  const activeWt = active?.worktrees?.find((w) => w.active === true);
  const showChip = props.showProjectChip !== false && !!active;

  return (
    <footer className="a2ui-status-bar">
      <span className="a2ui-status-left">{left}</span>
      {showChip ? (
        <span
          className="a2ui-status-project-chip"
          title={active?.tooltip ?? active?.label ?? ""}
          data-selectable
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
              <span className="a2ui-status-chip-branch">{active.git.branch}</span>
              {active.git.dirty ? (
                <span className="a2ui-status-chip-dirty" title="dirty">•</span>
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

// ---------------------------------------------------------------------------
// EmptyState — shown when the tabs array is empty (the user closed every
// open conversation). Lives inside default-layout, NOT inside App.tsx, so
// extensions can swap it for a different welcome screen by registering an
// override with the same component type. Emits "new-tab" on the primary
// button so App's onEvent handler can spin up a fresh tab.
// ---------------------------------------------------------------------------

export function EmptyState({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    subtitle?: StringValue;
    primaryButtonLabel?: StringValue;
    /** Optional ghost-styled secondary button. When set, fires
     *  "open-project" so App can pop the native folder picker. */
    secondaryButtonLabel?: StringValue;
    tips?: StringValue[];
    recentSessions?:
      | { id: string; label: string; lastModified?: string; cwd?: string }[]
      | { $ref: string };
    /** Recent projects list — shown alongside recent sessions so the
     *  user can hop between project directories without going through
     *  the picker. Same $ref + inline form as recentSessions. */
    recentProjects?:
      | { id: string; label: string; path: string; active?: boolean }[]
      | { $ref: string };
    /** Currently active project, displayed as a one-line breadcrumb
     *  above the action buttons so the user always knows what cwd a
     *  new tab will inherit. Null when no project is set. */
    activeProject?:
      | { id: string; label: string; path: string }
      | null
      | { $ref: string };
  };
  const title = props.title
    ? resolveString(props.title, state)
    : "Welcome to Aethon";
  const subtitle = props.subtitle
    ? resolveString(props.subtitle, state)
    : "All tabs are closed. Open a new one to start a conversation.";
  const primaryLabel = props.primaryButtonLabel
    ? resolveString(props.primaryButtonLabel, state)
    : "New Tab";
  const secondaryLabel = props.secondaryButtonLabel
    ? resolveString(props.secondaryButtonLabel, state)
    : "";
  const tips = props.tips ?? [];
  // Support both inline arrays AND $ref-bound recent-sessions lists so
  // App can push discovered persistent sessions into a single state
  // path (/recentSessions) and have the empty-state pick them up.
  const recentSessionsRaw = props.recentSessions;
  const recentSessions = (() => {
    if (!recentSessionsRaw) return [];
    if (Array.isArray(recentSessionsRaw)) return recentSessionsRaw;
    const resolved = resolvePointer(state, recentSessionsRaw.$ref);
    return Array.isArray(resolved)
      ? (resolved as {
          id: string;
          label: string;
          lastModified?: string;
          cwd?: string;
        }[])
      : [];
  })();
  const recentProjectsRaw = props.recentProjects;
  const recentProjects = (() => {
    if (!recentProjectsRaw) return [];
    if (Array.isArray(recentProjectsRaw)) return recentProjectsRaw;
    const resolved = resolvePointer(state, recentProjectsRaw.$ref);
    return Array.isArray(resolved)
      ? (resolved as {
          id: string;
          label: string;
          path: string;
          active?: boolean;
        }[])
      : [];
  })();
  const activeProjectRaw = props.activeProject;
  const activeProject = (() => {
    if (!activeProjectRaw) return null;
    if ("$ref" in activeProjectRaw) {
      const r = resolvePointer(state, activeProjectRaw.$ref);
      return r && typeof r === "object" && "label" in r
        ? (r as { id: string; label: string; path: string })
        : null;
    }
    return activeProjectRaw;
  })();

  return (
    <div className="a2ui-empty-state">
      <div className="a2ui-empty-state-card">
        <h1 className="a2ui-empty-state-title">{title}</h1>
        <p className="a2ui-empty-state-subtitle">{subtitle}</p>
        {activeProject && (
          <p className="a2ui-empty-state-active-project">
            <span className="a2ui-empty-state-active-project-label">
              {activeProject.label}
            </span>
            <span className="a2ui-empty-state-active-project-path">
              {activeProject.path}
            </span>
          </p>
        )}
        <div className="a2ui-empty-state-actions">
          <button
            type="button"
            className="a2ui-empty-state-primary"
            onClick={() => onEvent("new-tab")}
          >
            {primaryLabel}
          </button>
          {secondaryLabel && (
            <button
              type="button"
              className="a2ui-empty-state-secondary"
              onClick={() => onEvent("open-project")}
            >
              {secondaryLabel}
            </button>
          )}
        </div>
        {recentProjects.length > 0 && (
          <div className="a2ui-empty-state-recent">
            <h2>Recent projects</h2>
            <ul>
              {recentProjects.map((p) => (
                <li
                  key={p.id}
                  className={
                    p.active ? "a2ui-empty-state-recent-active" : undefined
                  }
                  onClick={() =>
                    onEvent(
                      "select-project",
                      { projectId: p.id, label: p.label, path: p.path },
                      p.id,
                    )
                  }
                >
                  <span className="a2ui-empty-state-recent-label">
                    {p.label}
                  </span>
                  <span className="a2ui-empty-state-recent-meta">{p.path}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {recentSessions.length > 0 && (
          <div className="a2ui-empty-state-recent">
            <h2>Recent sessions</h2>
            <ul>
              {recentSessions.map((s) => (
                <li
                  key={s.id}
                  onClick={() =>
                    // descendantId carries the session id so an extension's
                    // onEvent({componentType:"empty-state", descendantId:"…"})
                    // matcher can target a specific session row.
                    onEvent(
                      "restore-session",
                      { sessionId: s.id, label: s.label, cwd: s.cwd },
                      s.id,
                    )
                  }
                >
                  <span className="a2ui-empty-state-recent-label">
                    {s.label}
                  </span>
                  {s.lastModified && (
                    <span className="a2ui-empty-state-recent-meta">
                      {s.lastModified}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {tips.length > 0 && (
          <ul className="a2ui-empty-state-tips">
            {tips.map((tip, i) => (
              <li key={i}>{resolveString(tip, state)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
