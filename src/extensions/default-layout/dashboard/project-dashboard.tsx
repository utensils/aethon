/**
 * project-dashboard — per-project landing shown when a project is
 * active but no agent tab is open in it. Composes:
 *   - hero (project label + description from gh)
 *   - gh-stats-strip (stars/forks/issues/PRs/default branch/pushed-at)
 *   - task-launcher (Codex-style "start a task" composer)
 *   - workspace rail (existing workspaces + "New workspace" trigger)
 *   - recent sessions in this project
 *   - extension-injected widgets via /projectDashboard/widgets
 *
 * State paths read via $ref so any of the above can be live-mutated
 * (an extension can push into /projectDashboard/widgets, or replace any
 * registered component type via `aethon.registerComponent`).
 */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";
import { GhStatsStrip } from "./gh-stats-strip";
import { TaskLauncher } from "./task-launcher";
import { AeMarkInline } from "../layout";
import { RegistryComponent } from "../../../components/A2UIRenderer";
import { DashboardSessionRow } from "./session-row";
import {
  refreshRepoOverview,
  type GhRepoOverview,
} from "../../../ghRepoOverviewCache";

interface ProjectInfo {
  id: string;
  label: string;
  path: string;
  iconUrl?: string;
}

interface WorkspaceRowLite {
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

interface StartupPolicyStatus {
  root: string;
  autoApprove: boolean;
  hostAutoApprove: boolean;
  projectAutoApprove: boolean;
}

function isRef(v: unknown): v is { $ref: string } {
  return typeof v === "object" && v !== null && "$ref" in v;
}

function resolveOrInline<T>(
  v: unknown,
  state: Record<string, unknown>,
): T | null {
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

function projectIconUrlFromSidebar(
  state: Record<string, unknown>,
  projectId?: string,
): string | undefined {
  if (!projectId) return undefined;
  const sidebar = state.sidebar as
    | { projects?: Array<{ id?: string; iconUrl?: unknown }> }
    | undefined;
  const project = sidebar?.projects?.find((p) => p.id === projectId);
  return typeof project?.iconUrl === "string" ? project.iconUrl : undefined;
}

export function ProjectDashboard({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const [confirmingWorkspaceId, setConfirmingWorkspaceId] = useState<
    string | null
  >(null);
  const [startupPolicy, setStartupPolicy] =
    useState<StartupPolicyStatus | null>(null);
  const [startupPolicySaving, setStartupPolicySaving] = useState(false);
  const [startupPolicyError, setStartupPolicyError] = useState<string | null>(
    null,
  );
  const props = component.props as
    | {
        project?: unknown;
        workspaces?: unknown;
        recentSessions?: unknown;
        widgets?: unknown;
        repoOverview?: unknown;
        otherProjects?: unknown;
        activeWorkspaceId?: unknown;
      }
    | undefined;

  const project = useMemo(
    () => resolveOrInline<ProjectInfo>(props?.project, state),
    [props?.project, state],
  );
  const workspaces = useMemo(
    () => resolveArray<WorkspaceRowLite>(props?.workspaces, state),
    [props?.workspaces, state],
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
  const activeWorkspaceId = useMemo(
    () => resolveOrInline<string>(props?.activeWorkspaceId, state),
    [props?.activeWorkspaceId, state],
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

  // Eager refresh on project activation. Drops
  // the stale entry whenever `project.path` changes so the visible card
  // doesn't lag a project switch.
  useEffect(() => {
    const projectPath = project?.path;
    if (!projectPath) return;
    let cancelled = false;
    void (async () => {
      const o = await refreshRepoOverview(projectPath);
      if (!cancelled) setOverview({ path: projectPath, data: o });
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.path]);
  const overviewData = overview?.path === project?.path ? overview?.data : null;

  useEffect(() => {
    const projectPath = project?.path;
    if (!projectPath) return;
    let cancelled = false;
    setStartupPolicy(null);
    setStartupPolicyError(null);
    void (async () => {
      try {
        const status = await invoke<StartupPolicyStatus>(
          "workspace_startup_status",
          { args: { root: projectPath } },
        );
        if (!cancelled) setStartupPolicy(status);
      } catch (err) {
        if (!cancelled) {
          setStartupPolicyError(String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.path]);

  if (!project) return null;
  const iconUrl =
    projectIconUrlFromSidebar(state, project.id) ?? project.iconUrl;
  const startupInherited = startupPolicy?.hostAutoApprove === true;
  const startupChecked =
    startupPolicy?.hostAutoApprove === true ||
    startupPolicy?.projectAutoApprove === true;
  const startupDisabled =
    startupPolicySaving || startupInherited || startupPolicy === null;
  const startupHint = startupInherited
    ? "Enabled by host config"
    : startupPolicy?.projectAutoApprove
      ? "Trusted for this project in Aethon"
      : "Startup commands will still ask before running";
  const setProjectStartupAutoApprove = async (enabled: boolean) => {
    if (!project?.path) return;
    setStartupPolicySaving(true);
    setStartupPolicyError(null);
    try {
      const status = await invoke<StartupPolicyStatus>(
        "workspace_startup_set_auto_approve",
        { args: { root: project.path, enabled } },
      );
      setStartupPolicy(status);
    } catch (err) {
      setStartupPolicyError(String(err));
    } finally {
      setStartupPolicySaving(false);
    }
  };

  return (
    <div className="a2ui-project-dashboard">
      <div className="a2ui-project-dashboard-card">
        <header className="a2ui-project-dashboard-header">
          <div className="a2ui-project-dashboard-hero" aria-hidden="true">
            {iconUrl ? (
              <img
                src={iconUrl}
                alt=""
                className="a2ui-project-dashboard-icon"
                loading="lazy"
              />
            ) : (
              <AeMarkInline size={48} radius={10} />
            )}
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
                workspaces,
                activeWorkspaceId,
              },
            }}
            state={state}
            onEvent={onEvent}
          />
        </section>

        <section className="a2ui-project-dashboard-section a2ui-project-dashboard-startup-policy">
          <label className="a2ui-project-dashboard-startup-checkbox">
            <input
              type="checkbox"
              checked={startupChecked}
              disabled={startupDisabled}
              onChange={(event) =>
                void setProjectStartupAutoApprove(event.currentTarget.checked)
              }
            />
            <span className="a2ui-project-dashboard-startup-label">
              Auto-approve startup commands
            </span>
          </label>
          <span className="a2ui-project-dashboard-startup-hint">
            {startupPolicyError ?? startupHint}
          </span>
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
              activeWorkspaceIdRef: { $ref: "/activeWorkspaceId" },
            }}
          />
        </section>

        <section className="a2ui-project-dashboard-section">
          <RegistryComponent
            type="subagents-config"
            state={state}
            onEvent={(_component, eventType, data) =>
              onEvent(eventType, data, "subagents-config")
            }
            componentProps={{ scope: "project", projectPath: project.path }}
          />
        </section>

        {workspaces.length > 0 && (
          <section className="a2ui-project-dashboard-section">
            <header className="a2ui-project-dashboard-section-head">
              <h2>Workspaces</h2>
              <button
                type="button"
                className="a2ui-project-dashboard-section-action"
                onClick={() =>
                  onEvent("create-workspace", { projectId: project.id })
                }
              >
                + New workspace
              </button>
            </header>
            <ul className="a2ui-project-dashboard-workspaces">
              {workspaces.map((w) => {
                const label = w.label || w.branch || "workspace";
                const confirming = confirmingWorkspaceId === w.id;
                return (
                  <li
                    key={w.id}
                    className={
                      "a2ui-project-dashboard-workspace" +
                      (w.active ? " is-active" : "") +
                      (confirming ? " is-confirming" : "")
                    }
                    onMouseLeave={() => {
                      if (confirming) setConfirmingWorkspaceId(null);
                    }}
                    onClick={() => {
                      if (confirming) return;
                      onEvent(
                        "switch-workspace",
                        { workspaceId: w.id, projectId: project.id },
                        w.id,
                      );
                    }}
                    title={w.path}
                  >
                    <span className="a2ui-project-dashboard-workspace-label">
                      {label}
                    </span>
                    {w.branch && (
                      <span className="a2ui-project-dashboard-workspace-branch">
                        ⎇ {w.branch}
                      </span>
                    )}
                    {w.isMain ? (
                      <span className="a2ui-project-dashboard-workspace-main">
                        main
                      </span>
                    ) : confirming ? (
                      <button
                        type="button"
                        className="a2ui-project-dashboard-workspace-confirm-remove"
                        aria-label={`Confirm remove ${label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onEvent(
                            "remove-workspace",
                            {
                              workspaceId: w.id,
                              projectId: project.id,
                              confirmed: true,
                            },
                            w.id,
                          );
                        }}
                      >
                        Confirm
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="a2ui-project-dashboard-workspace-remove"
                        aria-label={`Remove ${label}`}
                        title="Remove workspace"
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfirmingWorkspaceId(w.id);
                        }}
                      >
                        <svg
                          viewBox="0 0 16 16"
                          width="14"
                          height="14"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <path
                            d="M5.5 2.75h5M6.25 2.75l.5-1h2.5l.5 1M3.5 4.5h9M5 4.5l.55 9h4.9l.55-9M7 6.5v5M9 6.5v5"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.35"
                          />
                        </svg>
                      </button>
                    )}
                  </li>
                );
              })}
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
