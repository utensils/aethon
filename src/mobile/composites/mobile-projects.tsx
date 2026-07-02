// Projects screen for the companion layout. This is the mobile equivalent
// of the desktop sidebar's host -> project -> workspace tree, expressed as
// a touch-first list while reusing the same route event contract.

import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

interface WorkspaceLike {
  id: string;
  projectId?: string;
  label?: string;
  branch?: string | null;
  path?: string;
  active?: boolean;
  isMain?: boolean;
  pendingState?: string;
  agent?: { status?: string; runningCount?: number };
}

interface ProjectLike {
  id: string;
  label?: string;
  tooltip?: string;
  path?: string;
  active?: boolean;
  iconUrl?: string;
  git?: { branch?: string; dirty?: boolean; ahead?: number; behind?: number };
  workspaces?: WorkspaceLike[];
  agent?: { status?: string; runningCount?: number };
  agentRollup?: { status?: string; runningCount?: number };
}

interface HostLike {
  id: string;
  label?: string;
  hint?: string;
  tooltip?: string;
  active?: boolean;
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

function agentClass(agent?: { status?: string }): string {
  if (agent?.status === "running") return " ae-mobile-agent--running";
  if (agent?.status === "needs-attention") return " ae-mobile-agent--attention";
  if (agent?.status === "idle") return " ae-mobile-agent--idle";
  return "";
}

function workspaceLabel(workspace: WorkspaceLike): string {
  if (workspace.isMain) return "Main";
  return workspace.label || workspace.branch || "Workspace";
}

function gitSummary(project: ProjectLike): string {
  const parts: string[] = [];
  if (project.git?.branch) parts.push(project.git.branch);
  if (project.git?.dirty) parts.push("modified");
  if (project.git?.ahead) parts.push(`${project.git.ahead} ahead`);
  if (project.git?.behind) parts.push(`${project.git.behind} behind`);
  return parts.join(" / ");
}

function mobileHostHint(host: HostLike): string {
  const hint = (host.hint || "").trim().toLowerCase();
  if (!hint || hint === "this mac") return "connected desktop";
  if (hint === "connected") return "desktop online";
  return host.hint || host.tooltip || "connected desktop";
}

export function MobileProjects({ state, onEvent }: BuiltinComponentProps) {
  const sidebar =
    (state.sidebar as { projects?: unknown; hosts?: unknown } | undefined) ?? {};
  const projects = (
    Array.isArray(sidebar.projects) ? sidebar.projects : []
  ) as ProjectLike[];
  const hosts = (
    Array.isArray(sidebar.hosts) ? sidebar.hosts : []
  ) as HostLike[];
  const activeProjectId =
    typeof state.activeProjectId === "string" ? state.activeProjectId : null;
  const activeWorkspaceId =
    typeof state.activeWorkspaceId === "string" ? state.activeWorkspaceId : null;
  const activeHostId =
    typeof state.activeHostId === "string" ? state.activeHostId : null;
  const activeHost =
    hosts.find((host) => host.active || host.id === activeHostId) ?? hosts[0];

  if (projects.length === 0) {
    return (
      <div className="ae-mobile-projects ae-mobile-projects-empty">
        <p>No projects yet.</p>
      </div>
    );
  }

  return (
    <div className="ae-mobile-projects">
      {activeHost ? (
        <button
          type="button"
          className="ae-mobile-host"
          onClick={() =>
            onEvent(
              "select",
              { sectionId: "hosts", itemId: activeHost.id },
              activeHost.id,
            )
          }
        >
          <span className="ae-mobile-host-dot" aria-hidden />
          <span className="ae-mobile-host-text">
            <span className="ae-mobile-host-name">
              {activeHost.label || "Host"}
            </span>
            <span className="ae-mobile-host-hint">
              {mobileHostHint(activeHost)}
            </span>
          </span>
          <span className="ae-mobile-projects-count">{projects.length}</span>
        </button>
      ) : (
        <div className="ae-mobile-projects-head">
          <span className="ae-mobile-projects-title">Projects</span>
          <span className="ae-mobile-projects-count">{projects.length}</span>
        </div>
      )}
      {projects.map((project) => {
        const projectPath = project.path || project.tooltip;
        const workspaces =
          project.workspaces && project.workspaces.length > 0
            ? project.workspaces
            : [
                {
                  id: `${project.id}:main`,
                  projectId: project.id,
                  label: "Main",
                  path: projectPath,
                  isMain: true,
                },
              ];
        const projectActive = project.id === activeProjectId;
        const mainActive = projectActive && activeWorkspaceId == null;
        const agent = project.agentRollup ?? project.agent;
        const meta = gitSummary(project) || displayPath(projectPath);
        return (
          <section
            key={project.id}
            className={`ae-mobile-project${projectActive ? " ae-mobile-project--active" : ""}`}
          >
            <button
              type="button"
              className="ae-mobile-project-main"
              onClick={() =>
                onEvent(
                  "select",
                  { sectionId: "projects", itemId: project.id },
                  project.id,
                )
              }
            >
              {project.iconUrl ? (
                <img
                  className="ae-mobile-project-icon"
                  src={project.iconUrl}
                  alt=""
                  aria-hidden
                />
              ) : (
                <span className="ae-mobile-project-icon" aria-hidden>
                  {baseName(project.label || projectPath || project.id).slice(0, 1)}
                </span>
              )}
              <span className="ae-mobile-project-title">
                <span className="ae-mobile-project-name">
                  {project.label || baseName(projectPath) || "Project"}
                </span>
                {meta ? (
                  <span className="ae-mobile-project-meta">{meta}</span>
                ) : null}
              </span>
              <span className="ae-mobile-project-state">
                {projectActive ? (
                  <span className="ae-mobile-project-active">Active</span>
                ) : null}
                <span
                  className={`ae-mobile-agent${agentClass(agent)}`}
                  aria-label={agent?.status ? `Agent ${agent.status}` : undefined}
                />
              </span>
            </button>

            <div className="ae-mobile-workspaces">
              {workspaces.map((workspace) => {
                const active = workspace.isMain
                  ? mainActive
                  : workspace.active || workspace.id === activeWorkspaceId;
                const path = workspace.path || projectPath;
                return (
                  <div
                    key={workspace.id}
                    className={`ae-mobile-workspace${active ? " ae-mobile-workspace--active" : ""}`}
                  >
                    <button
                      type="button"
                      className="ae-mobile-workspace-select"
                      onClick={() =>
                        workspace.isMain
                          ? onEvent(
                              "select",
                              { sectionId: "projects", itemId: project.id },
                              project.id,
                            )
                          : onEvent("switch-workspace", {
                              workspaceId: workspace.id,
                            })
                      }
                    >
                      <span className="ae-mobile-workspace-name">
                        {workspaceLabel(workspace)}
                      </span>
                      <span className="ae-mobile-workspace-meta">
                        {workspace.branch || displayPath(path)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ae-mobile-workspace-start"
                      onClick={() =>
                        onEvent("start-session", {
                          projectId: project.id,
                          workspaceId: workspace.isMain ? undefined : workspace.id,
                          path,
                        })
                      }
                    >
                      Start chat
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
