/**
 * project-dashboard — per-project landing shown when a project is
 * active but no agent tab is open in it. Composes:
 *   - hero (project label + description from gh)
 *   - gh-stats-strip (stars/forks/issues/PRs/default branch/pushed-at)
 *   - task-launcher (Codex-style "start a task" composer)
 *   - worktree rail (existing worktrees + "New worktree" trigger)
 *   - recent sessions in this project
 *   - extension-injected widgets via /projectDashboard/widgets
 *
 * State paths read via $ref so any of the above can be live-mutated
 * (an extension can push into /projectDashboard/widgets, or replace any
 * registered component type via `aethon.registerComponent`).
 */
import { useEffect, useMemo, useState } from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";
import { GhStatsStrip } from "./gh-stats-strip";
import { TaskLauncher } from "./task-launcher";
import { AeMarkInline } from "../layout";
import { RegistryComponent } from "../../../components/A2UIRenderer";
import { DashboardSessionRow } from "./session-row";
import {
  getRepoOverview,
  type GhRepoOverview,
} from "../../../ghRepoOverviewCache";

interface ProjectInfo {
  id: string;
  label: string;
  path: string;
  iconUrl?: string;
}

interface WorktreeRowLite {
  id: string;
  label: string;
  branch?: string;
  path: string;
  isMain?: boolean;
  active?: boolean;
}

interface SessionRow {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

interface DashboardWidget {
  id: string;
  type: string;
  title?: string;
  props?: Record<string, unknown>;
}

function isRef(v: unknown): v is { $ref: string } {
  return typeof v === "object" && v !== null && "$ref" in (v);
}

function resolveOrInline<T>(v: unknown, state: Record<string, unknown>): T | null {
  if (!v) return null;
  if (isRef(v)) {
    const r = resolvePointer(state, v.$ref);
    return (r ?? null) as T | null;
  }
  return v as T;
}

function resolveArray<T>(v: unknown, state: Record<string, unknown>): T[] {
  if (!v) return [];
  if (isRef(v)) {
    const r = resolvePointer(state, v.$ref);
    return Array.isArray(r) ? (r as T[]) : [];
  }
  return Array.isArray(v) ? (v as T[]) : [];
}

export function ProjectDashboard({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as
    | {
        project?: unknown;
        worktrees?: unknown;
        recentSessions?: unknown;
        widgets?: unknown;
        repoOverview?: unknown;
        otherProjects?: unknown;
        activeWorktreeId?: unknown;
      }
    | undefined;

  const project = useMemo(
    () => resolveOrInline<ProjectInfo>(props?.project, state),
    [props?.project, state],
  );
  const worktrees = useMemo(
    () => resolveArray<WorktreeRowLite>(props?.worktrees, state),
    [props?.worktrees, state],
  );
  const recentSessions = useMemo(
    () => resolveArray<SessionRow>(props?.recentSessions, state),
    [props?.recentSessions, state],
  );
  const widgets = useMemo(
    () => resolveArray<DashboardWidget>(props?.widgets, state),
    [props?.widgets, state],
  );
  const repoOverviewProp = useMemo(
    () => resolveOrInline<GhRepoOverview>(props?.repoOverview, state),
    [props?.repoOverview, state],
  );
  const otherProjects = useMemo(
    () => resolveArray<ProjectInfo>(props?.otherProjects, state),
    [props?.otherProjects, state],
  );
  const activeWorktreeId = useMemo(
    () => resolveOrInline<string>(props?.activeWorktreeId, state),
    [props?.activeWorktreeId, state],
  );

  // Key the cached overview by path so switching from project A to
  // project B doesn't render A's description on top of B's tile. When
  // the prop changes shape (e.g. an extension overwrites
  // /projectDashboard/repoOverview) we still respect it as the seed,
  // but a project change resets to null + re-fetches.
  const [overview, setOverview] = useState<{
    path: string;
    data: GhRepoOverview | null;
  } | null>(
    project && repoOverviewProp
      ? { path: project.path, data: repoOverviewProp }
      : null,
  );

  // Eager fetch on project activation. The cache handles dedupe. Drops
  // the stale entry whenever `project.path` changes so the visible card
  // doesn't lag a project switch.
  useEffect(() => {
    if (!project) return;
    if (overview?.path === project.path && overview.data?.repo) return;
    let cancelled = false;
    // Optimistic clear so the previous project's strip / description
    // doesn't briefly render under the new project's title.
    if (overview && overview.path !== project.path) {
      setOverview(null);
    }
    void (async () => {
      const o = await getRepoOverview(project.path);
      if (!cancelled) setOverview({ path: project.path, data: o });
    })();
    return () => {
      cancelled = true;
    };
  }, [project, overview]);
  const overviewData = overview?.path === project?.path ? overview?.data : null;

  if (!project) return null;

  return (
    <div className="a2ui-project-dashboard">
      <div className="a2ui-project-dashboard-card">
        <header className="a2ui-project-dashboard-header">
          <div className="a2ui-project-dashboard-hero" aria-hidden="true">
            <AeMarkInline size={48} radius={10} />
          </div>
          <div className="a2ui-project-dashboard-header-text">
            <h1 className="a2ui-project-dashboard-title">{project.label}</h1>
            <p className="a2ui-project-dashboard-path">{project.path}</p>
            {overviewData?.description && (
              <p className="a2ui-project-dashboard-description">
                {overviewData.description}
              </p>
            )}
          </div>
        </header>

        <GhStatsStrip
          component={{
            id: "project-dashboard-stats",
            type: "gh-stats-strip",
            props: { overview: overviewData ?? null },
          }}
          state={state}
          onEvent={onEvent}
        />

        <section className="a2ui-project-dashboard-section">
          <TaskLauncher
            component={{
              id: "project-dashboard-launcher",
              type: "task-launcher",
              props: {
                project,
                otherProjects,
                worktrees,
                activeWorktreeId,
              },
            }}
            state={state}
            onEvent={onEvent}
          />
        </section>

        <section className="a2ui-project-dashboard-section a2ui-project-dashboard-issues-wrap">
          <RegistryComponent
            type="issues-section"
            state={state}
            onEvent={(_component, eventType, data) =>
              onEvent(eventType, data, "issues-section")
            }
            componentProps={{
              project,
              activeWorktreeIdRef: { $ref: "/activeWorktreeId" },
            }}
          />
        </section>

        {worktrees.length > 0 && (
          <section className="a2ui-project-dashboard-section">
            <header className="a2ui-project-dashboard-section-head">
              <h2>Worktrees</h2>
              <button
                type="button"
                className="a2ui-project-dashboard-section-action"
                onClick={() =>
                  onEvent("create-worktree", { projectId: project.id })
                }
              >
                + New worktree
              </button>
            </header>
            <ul className="a2ui-project-dashboard-worktrees">
              {worktrees.map((w) => (
                <li
                  key={w.id}
                  className={
                    "a2ui-project-dashboard-worktree" +
                    (w.active ? " is-active" : "")
                  }
                  onClick={() =>
                    onEvent(
                      "switch-worktree",
                      { worktreeId: w.id, projectId: project.id },
                      w.id,
                    )
                  }
                  title={w.path}
                >
                  <span className="a2ui-project-dashboard-worktree-label">
                    {w.label || w.branch || "worktree"}
                  </span>
                  {w.branch && (
                    <span className="a2ui-project-dashboard-worktree-branch">
                      ⎇ {w.branch}
                    </span>
                  )}
                  {w.isMain && (
                    <span className="a2ui-project-dashboard-worktree-main">
                      main
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {recentSessions.length > 0 && (
          <section className="a2ui-project-dashboard-section">
            <h2>Recent sessions</h2>
            <ul className="a2ui-project-dashboard-sessions">
              {recentSessions.slice(0, 8).map((s) => (
                <DashboardSessionRow
                  key={s.id}
                  session={s}
                  classPrefix="a2ui-project-dashboard"
                  onRestore={() =>
                    onEvent(
                      "restore-session",
                      { sessionId: s.id, label: s.label, cwd: s.cwd },
                      s.id,
                    )
                  }
                  onDelete={() =>
                    onEvent(
                      "delete-session",
                      { sessionId: s.id, label: s.label, confirmed: true },
                      s.id,
                    )
                  }
                />
              ))}
            </ul>
          </section>
        )}

        {widgets.length > 0 && (
          <section className="a2ui-project-dashboard-section a2ui-project-dashboard-widgets">
            {widgets.map((w) => (
              <div
                key={w.id}
                className="a2ui-project-dashboard-widget"
                data-widget-id={w.id}
              >
                {w.title && (
                  <h3 className="a2ui-project-dashboard-widget-title">
                    {w.title}
                  </h3>
                )}
                <RegistryComponent
                  type={w.type}
                  state={state}
                  onEvent={(_component, eventType, data) =>
                    onEvent(eventType, data, w.id)
                  }
                  componentProps={w.props ?? { project }}
                />
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
