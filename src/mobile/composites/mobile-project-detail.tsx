// Touch-first project overview for the companion layout. It mirrors the
// desktop project dashboard's information architecture without trying to
// squeeze the desktop dashboard into a phone-width webview.

import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

interface GitStatusLike {
  branch?: string | null;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
}

interface WorkspaceLike {
  id: string;
  projectId?: string;
  label?: string;
  branch?: string | null;
  path?: string;
  active?: boolean;
  isMain?: boolean;
  pendingState?: string;
  git?: GitStatusLike;
}

interface ProjectLike {
  id: string;
  label?: string;
  tooltip?: string;
  path?: string;
  active?: boolean;
  iconUrl?: string;
  git?: GitStatusLike;
  workspaces?: WorkspaceLike[];
}

interface SessionLike {
  id: string;
  label?: string;
  cwd?: string;
  lastModified?: string;
}

interface VcsLike {
  root?: string | null;
  branch?: string | null;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  loading?: boolean;
  changes?: {
    total?: number;
    insertions?: number;
    deletions?: number;
    files?: Array<{ path: string; status: string }>;
  };
  pr?: { number?: number; title?: string; state?: string; url?: string } | null;
  ci?: {
    conclusion?: string | null;
    total?: number;
    passed?: number;
    failed?: number;
    pending?: number;
  } | null;
}

function baseName(path?: string): string {
  if (!path) return "";
  const cleaned = path.replace(/[/\\]+$/, "");
  const parts = cleaned.split(/[/\\]/);
  return parts[parts.length - 1] || cleaned;
}

function displayPath(path?: string): string {
  if (!path) return "";
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function workspaceLabel(workspace: WorkspaceLike): string {
  if (workspace.isMain) return "Main";
  return workspace.label || workspace.branch || "Workspace";
}

function gitParts(git?: GitStatusLike | null): string[] {
  if (!git) return [];
  const parts: string[] = [];
  if (git.branch) parts.push(git.branch);
  if (git.dirty) parts.push("modified");
  if (git.ahead) parts.push(`${git.ahead} ahead`);
  if (git.behind) parts.push(`${git.behind} behind`);
  return parts;
}

function sessionTime(session: SessionLike): string {
  if (!session.lastModified) return "";
  const when = new Date(session.lastModified);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function activeProjectFromState(
  state: Record<string, unknown>,
): ProjectLike | null {
  const sidebar =
    (state.sidebar as { projects?: unknown } | undefined)?.projects ?? [];
  const projects = Array.isArray(sidebar) ? (sidebar as ProjectLike[]) : [];
  const detailProjectId =
    (state.mobileProjectDetail as { projectId?: unknown } | undefined)
      ?.projectId ?? null;
  const stateProject = state.project as
    | { id?: unknown; path?: unknown }
    | null
    | undefined;
  const activeId =
    typeof detailProjectId === "string"
      ? detailProjectId
      : typeof state.activeProjectId === "string"
        ? state.activeProjectId
        : typeof stateProject?.id === "string"
          ? stateProject.id
          : null;
  return (
    projects.find((project) => project.id === activeId) ??
    (typeof stateProject?.id === "string"
      ? {
          id: stateProject.id,
          label: baseName(
            typeof stateProject.path === "string" ? stateProject.path : "",
          ),
          path: typeof stateProject.path === "string" ? stateProject.path : "",
        }
      : null)
  );
}

function dashboardWorkspaces(
  state: Record<string, unknown>,
  project: ProjectLike,
): WorkspaceLike[] {
  const dashboard = state.projectDashboard as
    | { workspaces?: unknown }
    | undefined;
  const fromDashboard = Array.isArray(dashboard?.workspaces)
    ? (dashboard.workspaces as WorkspaceLike[])
    : [];
  const raw = fromDashboard.length > 0 ? fromDashboard : (project.workspaces ?? []);
  if (raw.length > 0) return raw;
  return [
    {
      id: `${project.id}:main`,
      projectId: project.id,
      label: "Main",
      path: project.path || project.tooltip,
      isMain: true,
    },
  ];
}

function dashboardSessions(state: Record<string, unknown>): SessionLike[] {
  const dashboard = state.projectDashboard as
    | { recentSessions?: unknown }
    | undefined;
  return Array.isArray(dashboard?.recentSessions)
    ? (dashboard.recentSessions as SessionLike[])
    : [];
}

export function MobileProjectDetail({
  state,
  onEvent,
}: BuiltinComponentProps) {
  const project = activeProjectFromState(state);
  if (!project) {
    return (
      <div className="ae-mobile-project-detail ae-mobile-project-detail-empty">
        <button
          type="button"
          className="ae-mobile-detail-back"
          onClick={() => onEvent("back", {})}
        >
          Projects
        </button>
        <p>Select a project to see its overview.</p>
      </div>
    );
  }

  const activeWorkspaceId =
    typeof state.activeWorkspaceId === "string" ? state.activeWorkspaceId : null;
  const projectPath = project.path || project.tooltip || "";
  const workspaces = dashboardWorkspaces(state, project);
  const sessions = dashboardSessions(state);
  const vcs = (state.vcs as VcsLike | undefined) ?? null;
  const activeWorkspace =
    workspaces.find((workspace) =>
      workspace.isMain
        ? activeWorkspaceId == null
        : workspace.active || workspace.id === activeWorkspaceId,
    ) ?? workspaces[0];
  const gitSummary =
    gitParts(vcs?.root ? vcs : project.git).join(" / ") || "No git summary yet";
  const changeCount = vcs?.changes?.total ?? 0;
  const issueRows = [
    vcs?.pr
      ? {
          key: "pr",
          label: `PR #${vcs.pr.number ?? ""}`,
          value: vcs.pr.title || vcs.pr.state || "Pull request",
          tone: "info",
        }
      : null,
    vcs?.ci
      ? {
          key: "ci",
          label: "CI",
          value:
            vcs.ci.conclusion ||
            `${vcs.ci.passed ?? 0}/${vcs.ci.total ?? 0} passing`,
          tone: (vcs.ci.failed ?? 0) > 0 ? "danger" : "info",
        }
      : null,
    changeCount > 0
      ? {
          key: "changes",
          label: "Working tree",
          value: `${changeCount} changed`,
          tone: "warning",
        }
      : null,
  ].filter((row): row is { key: string; label: string; value: string; tone: string } =>
    Boolean(row),
  );

  return (
    <div className="ae-mobile-project-detail">
      <header className="ae-mobile-detail-header">
        <button
          type="button"
          className="ae-mobile-detail-back"
          onClick={() => onEvent("back", {})}
        >
          Projects
        </button>
        <button
          type="button"
          className="ae-mobile-detail-primary"
          onClick={() =>
            onEvent("start-session", {
              projectId: project.id,
              workspaceId: activeWorkspace?.isMain ? undefined : activeWorkspace?.id,
              path: activeWorkspace?.path || projectPath,
            })
          }
        >
          Start chat
        </button>
      </header>

      <section className="ae-mobile-detail-hero">
        {project.iconUrl ? (
          <img
            className="ae-mobile-detail-icon"
            src={project.iconUrl}
            alt=""
            aria-hidden
          />
        ) : (
          <span className="ae-mobile-detail-icon" aria-hidden>
            {(project.label || baseName(projectPath) || project.id).slice(0, 1)}
          </span>
        )}
        <div className="ae-mobile-detail-title">
          <h1>{project.label || baseName(projectPath) || "Project"}</h1>
          <p>{displayPath(projectPath)}</p>
        </div>
      </section>

      <section className="ae-mobile-detail-strip" aria-label="Project summary">
        <span>
          <strong>{workspaces.length}</strong>
          <small>workspaces</small>
        </span>
        <span>
          <strong>{sessions.length}</strong>
          <small>sessions</small>
        </span>
        <span>
          <strong>{changeCount}</strong>
          <small>changes</small>
        </span>
      </section>

      <section className="ae-mobile-detail-section">
        <div className="ae-mobile-detail-section-head">
          <h2>Overview</h2>
        </div>
        <div className="ae-mobile-detail-facts">
          <span>Active workspace</span>
          <strong>{activeWorkspace ? workspaceLabel(activeWorkspace) : "Main"}</strong>
          <span>Branch</span>
          <strong>{gitSummary}</strong>
          <span>Root</span>
          <strong>{displayPath(activeWorkspace?.path || projectPath)}</strong>
        </div>
      </section>

      <section className="ae-mobile-detail-section">
        <div className="ae-mobile-detail-section-head">
          <h2>Workspaces</h2>
          <button
            type="button"
            onClick={() => onEvent("create-workspace", { projectId: project.id })}
          >
            New
          </button>
        </div>
        <div className="ae-mobile-detail-list">
          {workspaces.map((workspace) => {
            const active = workspace.isMain
              ? activeWorkspaceId == null
              : workspace.active || workspace.id === activeWorkspaceId;
            const path = workspace.path || projectPath;
            return (
              <article
                key={workspace.id}
                className={`ae-mobile-detail-row${active ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className="ae-mobile-detail-row-main"
                  onClick={() =>
                    workspace.isMain
                      ? onEvent(
                          "select",
                          { sectionId: "projects", itemId: project.id },
                          project.id,
                        )
                      : onEvent("switch-workspace", {
                          projectId: project.id,
                          workspaceId: workspace.id,
                        })
                  }
                >
                  <span>{workspaceLabel(workspace)}</span>
                  <small>{workspace.branch || displayPath(path)}</small>
                </button>
                <button
                  type="button"
                  className="ae-mobile-detail-row-action"
                  onClick={() =>
                    onEvent("start-session", {
                      projectId: project.id,
                      workspaceId: workspace.isMain ? undefined : workspace.id,
                      path,
                    })
                  }
                >
                  Chat
                </button>
              </article>
            );
          })}
        </div>
      </section>

      <section className="ae-mobile-detail-section">
        <div className="ae-mobile-detail-section-head">
          <h2>Issues</h2>
          <button
            type="button"
            onClick={() => onEvent("open-screen", { screen: "git" })}
          >
            Git
          </button>
        </div>
        {issueRows.length > 0 ? (
          <div className="ae-mobile-detail-list">
            {issueRows.map((row) => (
              <div
                key={row.key}
                className={`ae-mobile-detail-issue is-${row.tone}`}
              >
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
        ) : (
          <p className="ae-mobile-detail-empty-copy">
            No source control issues reported for this workspace.
          </p>
        )}
      </section>

      {sessions.length > 0 ? (
        <section className="ae-mobile-detail-section">
          <div className="ae-mobile-detail-section-head">
            <h2>Recent sessions</h2>
            <button
              type="button"
              onClick={() => onEvent("open-screen", { screen: "sessions" })}
            >
              All
            </button>
          </div>
          <div className="ae-mobile-detail-list">
            {sessions.slice(0, 5).map((session) => (
              <button
                key={session.id}
                type="button"
                className="ae-mobile-detail-session"
                onClick={() =>
                  onEvent("restore-session", {
                    sessionId: session.id,
                    label: session.label,
                    cwd: session.cwd,
                  })
                }
              >
                <span>{session.label || "Untitled session"}</span>
                <small>{sessionTime(session) || displayPath(session.cwd)}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="ae-mobile-detail-actions" aria-label="Project tools">
        <button type="button" onClick={() => onEvent("open-screen", { screen: "files" })}>
          Files
        </button>
        <button
          type="button"
          onClick={() => onEvent("open-screen", { screen: "terminal" })}
        >
          Terminal
        </button>
        <button type="button" onClick={() => onEvent("open-screen", { screen: "git" })}>
          Git
        </button>
      </section>
    </div>
  );
}
