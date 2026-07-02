// Touch-first project overview for the companion layout. It mirrors the
// desktop project dashboard's information architecture without trying to
// squeeze the desktop dashboard into a phone-width webview.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { DEFAULT_WORKSPACE_BASE_BRANCH } from "../../projects";
import {
  type GhIssue,
  getIssueDetail,
  refreshIssues,
} from "../../ghIssuesCache";
import { buildIssueTask } from "../../extensions/default-layout/dashboard/issue-task";
import {
  loadIssueTemplates,
  matchingIssueTemplates,
  type IssueTemplate,
} from "../../extensions/default-layout/dashboard/issue-templates";
import { firstIssueSessionTab } from "../../extensions/default-layout/dashboard/issue-sessions";
import { formatRelativeTime } from "../../utils/time";

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
  workspaceBaseBranch?: string;
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
  const raw =
    fromDashboard.length > 0 ? fromDashboard : (project.workspaces ?? []);
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

function projectWorkspaceBranches(
  state: Record<string, unknown>,
  projectId: string,
): Set<string> {
  const sidebar =
    (state.sidebar as
      | {
          projects?: {
            id: string;
            workspaces?: { branch?: string | null; label?: string }[];
          }[];
        }
      | undefined) ?? {};
  const project = sidebar.projects?.find((p) => p.id === projectId);
  return new Set(
    (project?.workspaces ?? [])
      .flatMap((workspace) => [workspace.branch, workspace.label])
      .filter((value): value is string => Boolean(value)),
  );
}

function currentProjectWorkspaceId(
  state: Record<string, unknown>,
  projectId: string,
): string | undefined {
  const activeWorkspaceId =
    typeof state.activeWorkspaceId === "string" &&
    state.activeWorkspaceId.length > 0
      ? state.activeWorkspaceId
      : undefined;
  const sidebar =
    (state.sidebar as
      | { projects?: { id: string; workspaces?: WorkspaceLike[] }[] }
      | undefined) ?? {};
  const project = sidebar.projects?.find((p) => p.id === projectId);
  const workspace =
    project?.workspaces?.find((w) => w.id === activeWorkspaceId) ??
    project?.workspaces?.find((w) => w.active === true);
  return workspace?.id;
}

function issueSessionStatus(
  state: Record<string, unknown>,
  projectId: string,
  issue: GhIssue,
): { tabId: string; label: string } | null {
  const tab = firstIssueSessionTab(state, projectId, issue.number);
  if (!tab?.sourceIssue) return null;
  const running = Boolean(
    (state.agentRunningTabs as Record<string, unknown> | undefined)?.[tab.id],
  );
  const attention = Boolean(
    (state.agentAttentionTabs as Record<string, unknown> | undefined)?.[tab.id],
  );
  return {
    tabId: tab.id,
    label: running ? "Working" : attention ? "Ready" : "Open",
  };
}

export function MobileProjectDetail({ state, onEvent }: BuiltinComponentProps) {
  const project = activeProjectFromState(state);
  const projectPath = project?.path || project?.tooltip || "";
  const [issues, setIssues] = useState<GhIssue[] | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [issueTemplates, setIssueTemplates] = useState<IssueTemplate[]>([]);
  const [templateWarning, setTemplateWarning] = useState<string | null>(null);
  const [sendingIssue, setSendingIssue] = useState<number | null>(null);

  useEffect(() => {
    if (!project || !projectPath) return;
    if (loadedFor === projectPath) return;
    let cancelled = false;
    void (async () => {
      const [fetched, templateConfig] = await Promise.all([
        refreshIssues(projectPath, 12),
        loadIssueTemplates(projectPath),
      ]);
      if (cancelled) return;
      setIssues(fetched);
      setIssueTemplates(templateConfig.templates);
      setTemplateWarning(templateConfig.warning);
      onEvent(
        "issues-refreshed",
        {
          projectId: project.id,
          openIssueNumbers: fetched.map((issue) => issue.number),
        },
        "mobile-issues",
      );
      setLoadedFor(projectPath);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadedFor, onEvent, project, projectPath]);

  const sendIssueToAgent = useCallback(
    async (issue: GhIssue) => {
      if (!project || !projectPath) return;
      const existing = firstIssueSessionTab(state, project.id, issue.number);
      if (existing) {
        onEvent(
          "open-issue-session",
          { tabId: existing.id, issueNumber: issue.number },
          `issue-${issue.number}`,
        );
        return;
      }
      setSendingIssue(issue.number);
      try {
        const detail = await getIssueDetail(projectPath, issue.number);
        const template =
          matchingIssueTemplates(issueTemplates, issue)[0] ?? null;
        const task = buildIssueTask(
          detail,
          issue,
          {
            id: project.id,
            label: project.label || baseName(projectPath) || project.id,
            path: projectPath,
          },
          {
            template,
            forceNewWorkspace: true,
            existingBranches: projectWorkspaceBranches(state, project.id),
          },
        );
        onEvent(
          "start-task",
          {
            projectId: project.id,
            prompt: task.prompt,
            newWorkspace: task.newWorkspace,
            branch: task.branch,
            baseBranch: task.newWorkspace
              ? (project.workspaceBaseBranch ?? DEFAULT_WORKSPACE_BASE_BRANCH)
              : undefined,
            workspaceId: task.newWorkspace
              ? undefined
              : currentProjectWorkspaceId(state, project.id),
            source: "github-issue",
            issueNumber: issue.number,
            issueUrl: issue.url,
            issueTitle: issue.title,
            issueTemplateId: task.templateId,
            issueTemplateLabel: task.templateLabel,
          },
          `issue-${issue.number}`,
        );
      } catch (err) {
        console.warn("mobile issue dispatch failed:", err);
      } finally {
        setSendingIssue(null);
      }
    },
    [issueTemplates, onEvent, project, projectPath, state],
  );

  const loadedForActiveProject = loadedFor === projectPath;
  const issuesForProject = loadedForActiveProject ? issues : null;
  const templateWarningForProject = loadedForActiveProject
    ? templateWarning
    : null;
  const issueList = useMemo(() => issuesForProject ?? [], [issuesForProject]);

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
    typeof state.activeWorkspaceId === "string"
      ? state.activeWorkspaceId
      : null;
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
  ].filter(
    (row): row is { key: string; label: string; value: string; tone: string } =>
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
              workspaceId: activeWorkspace?.isMain
                ? undefined
                : activeWorkspace?.id,
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
          <strong>
            {activeWorkspace ? workspaceLabel(activeWorkspace) : "Main"}
          </strong>
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
            onClick={() =>
              onEvent("create-workspace", { projectId: project.id })
            }
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
        {templateWarningForProject ? (
          <p className="ae-mobile-detail-empty-copy">
            {templateWarningForProject}
          </p>
        ) : null}
        {issuesForProject === null ? (
          <p className="ae-mobile-detail-empty-copy">
            Loading GitHub issues...
          </p>
        ) : null}
        {issueList.length > 0 || issueRows.length > 0 ? (
          <div className="ae-mobile-detail-list">
            {issueList.map((issue) => {
              const session = issueSessionStatus(state, project.id, issue);
              const isSending = sendingIssue === issue.number;
              return (
                <article
                  key={issue.number}
                  className="ae-mobile-detail-issue is-gh"
                >
                  <button
                    type="button"
                    className="ae-mobile-detail-issue-main"
                    onClick={() => onEvent("open-url", { url: issue.url })}
                  >
                    <span>Issue #{issue.number}</span>
                    <strong>{issue.title}</strong>
                    <small>
                      {issue.updatedAt
                        ? `updated ${formatRelativeTime(Date.parse(issue.updatedAt))}`
                        : "open issue"}
                    </small>
                  </button>
                  <button
                    type="button"
                    className="ae-mobile-detail-row-action"
                    disabled={isSending}
                    aria-label={
                      session
                        ? `Open session for issue #${issue.number}`
                        : `Send issue #${issue.number} to agent`
                    }
                    onClick={() =>
                      session
                        ? onEvent(
                            "open-issue-session",
                            { tabId: session.tabId, issueNumber: issue.number },
                            `issue-${issue.number}`,
                          )
                        : void sendIssueToAgent(issue)
                    }
                  >
                    {isSending ? "..." : (session?.label ?? "Agent")}
                  </button>
                </article>
              );
            })}
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
        ) : issuesForProject !== null ? (
          <p className="ae-mobile-detail-empty-copy">
            No GitHub issues or source control warnings for this workspace.
          </p>
        ) : null}
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
                <small>
                  {sessionTime(session) || displayPath(session.cwd)}
                </small>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="ae-mobile-detail-actions" aria-label="Project tools">
        <button
          type="button"
          onClick={() => onEvent("open-screen", { screen: "files" })}
        >
          Files
        </button>
        <button
          type="button"
          onClick={() => onEvent("open-screen", { screen: "terminal" })}
        >
          Terminal
        </button>
        <button
          type="button"
          onClick={() => onEvent("open-screen", { screen: "git" })}
        >
          Git
        </button>
      </section>
    </div>
  );
}
