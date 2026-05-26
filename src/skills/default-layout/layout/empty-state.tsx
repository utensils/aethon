/**
 * `EmptyState` — full-canvas welcome shown when the tabs array is empty
 * (the user closed every open conversation). Lives inside default-layout,
 * NOT inside App.tsx, so extensions can swap it for a different welcome
 * screen by registering an override with the same component type. Emits
 * "new-tab" on the primary button so App's onEvent handler can spin up
 * a fresh tab; the secondary button (when configured) emits
 * "open-project" to pop the native folder picker.
 */

import { resolvePointer } from "../../../utils/jsonPointer";
import { resolveString } from "../../../utils/dataBinding";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { StringValue } from "../../../types/a2ui";
import { AeMarkInline } from "./mark";

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
        <div className="a2ui-empty-state-hero" aria-hidden="true">
          <AeMarkInline size={64} radius={12} />
        </div>
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
