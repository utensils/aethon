/**
 * projects-dashboard — global overview shown when no project is active
 * and all tabs are closed. Hero + CTA row + responsive grid of
 * project-card composites + recent-sessions rail.
 *
 * Reads data via $ref bindings so live mutations and extension state
 * patches reflect immediately:
 *   - projects: /projects (array of {id, label, path, active})
 *   - recentSessions: /recentSessions
 *   - extraCards: /projectsDashboard/extraCards (extension-injected
 *     custom tiles, optional)
 *
 * Events:
 *   - "new-tab" / "open-project" — reuse existing tabStrip event routes
 *     so the global empty-state behaviour stays consistent.
 *   - "select-project-card" (forwarded from project-card) → activates.
 *   - "restore-session" — reuses tabStrip route too.
 */
import { useMemo } from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";
import { AeMarkInline } from "../layout";
import { RegistryComponent } from "../../../components/A2UIRenderer";

interface ProjectListItem {
  id: string;
  label: string;
  path: string;
  active?: boolean;
  gitStatus?: { branch?: string; dirty?: boolean; ahead?: number; behind?: number };
}

interface RecentSession {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

interface ExtraCard {
  id: string;
  type: string;
  props?: Record<string, unknown>;
}

function isRef(v: unknown): v is { $ref: string } {
  return typeof v === "object" && v !== null && "$ref" in (v);
}

function resolveArray<T>(v: unknown, state: Record<string, unknown>): T[] {
  if (!v) return [];
  if (isRef(v)) {
    const r = resolvePointer(state, v.$ref);
    return Array.isArray(r) ? (r as T[]) : [];
  }
  return Array.isArray(v) ? (v as T[]) : [];
}

export function ProjectsDashboard({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as
    | {
        projects?: unknown;
        recentSessions?: unknown;
        extraCards?: unknown;
        title?: string;
        subtitle?: string;
      }
    | undefined;

  const projects = useMemo(
    () => resolveArray<ProjectListItem>(props?.projects, state),
    [props?.projects, state],
  );
  const recentSessions = useMemo(
    () => resolveArray<RecentSession>(props?.recentSessions, state),
    [props?.recentSessions, state],
  );
  const extraCards = useMemo(
    () => resolveArray<ExtraCard>(props?.extraCards, state),
    [props?.extraCards, state],
  );

  return (
    <div className="a2ui-projects-dashboard">
      <div className="a2ui-projects-dashboard-card">
        <div className="a2ui-projects-dashboard-hero" aria-hidden="true">
          <AeMarkInline size={56} radius={12} />
        </div>
        <h1 className="a2ui-projects-dashboard-title">
          {props?.title ?? "Projects"}
        </h1>
        <p className="a2ui-projects-dashboard-subtitle">
          {props?.subtitle ??
            "Pick a project to keep working, or start something new."}
        </p>
        <div className="a2ui-projects-dashboard-actions">
          <button
            type="button"
            className="a2ui-projects-dashboard-primary"
            onClick={() => onEvent("open-project")}
          >
            Open Project…
          </button>
          <button
            type="button"
            className="a2ui-projects-dashboard-secondary"
            onClick={() => onEvent("new-tab")}
          >
            New Tab
          </button>
        </div>
        {projects.length > 0 && (
          <section className="a2ui-projects-dashboard-section">
            <h2>Recent projects</h2>
            <div className="a2ui-projects-dashboard-grid">
              {projects.map((p) => (
                // Route through RegistryComponent (NOT the direct
                // `<ProjectCard>` import) so an extension that calls
                // `aethon.registerComponent("project-card", Custom)`
                // can replace tiles globally. The "overrideable by
                // type string" contract has to hold here or the
                // override-everything story breaks on the most
                // visible surface in the app.
                <RegistryComponent
                  key={p.id}
                  type="project-card"
                  state={state}
                  onEvent={(_component, eventType, data) =>
                    onEvent(eventType, data, `project-card-${p.id}`)
                  }
                  componentProps={{
                    project: p,
                    active: p.active === true,
                  }}
                />
              ))}
              {extraCards.map((card) => (
                <RegistryComponent
                  key={card.id}
                  type={card.type}
                  state={state}
                  onEvent={(_component, eventType, data) =>
                    onEvent(eventType, data, card.id)
                  }
                  componentProps={card.props ?? {}}
                />
              ))}
            </div>
          </section>
        )}
        {recentSessions.length > 0 && (
          <section className="a2ui-projects-dashboard-section">
            <h2>Recent sessions</h2>
            <ul className="a2ui-projects-dashboard-sessions">
              {recentSessions.slice(0, 6).map((s) => (
                <li
                  key={s.id}
                  onClick={() =>
                    onEvent(
                      "restore-session",
                      { sessionId: s.id, label: s.label, cwd: s.cwd },
                      s.id,
                    )
                  }
                >
                  <span className="a2ui-projects-dashboard-session-label">
                    {s.label}
                  </span>
                  {s.lastModified && (
                    <span className="a2ui-projects-dashboard-session-meta">
                      {s.lastModified}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
