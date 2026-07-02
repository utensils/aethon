/**
 * `WorkspaceLanding` — full-canvas landing shown when the user clicks a
 * workspace in the sidebar but hasn't yet started a session in it.
 * Mirrors `EmptyState`'s visual shape (AeMark hero + active-target chip
 * + CTAs) but scoped to a single workspace. The "Start Session" CTA
 * spawns a fresh agent tab whose cwd is the workspace's path; "Open in
 * Files" reveals it in the system file manager.
 *
 * Visibility is driven by `/landing/kind === "workspace"` — sidebar
 * emits the "switch-workspace" event which the app handles by writing
 * to `/landing`. Selecting any tab clears `/landing` so the canvas
 * snaps back.
 *
 * Branch status (pushed / PR open / merged) is fetched via `gh` from
 * the cache module; missing/unauthed gh just collapses to "Connect
 * GitHub" in the UI rather than erroring.
 */

import { useEffect, useState } from "react";
import { resolvePointer } from "../../../utils/jsonPointer";
import {
  getGhBranchStatus,
  type GhBranchStatus,
} from "../../../ghBranchStatusCache";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { DashboardSessionRow } from "../dashboard/session-row";
import { AeMarkInline } from "./mark";

export function WorkspaceLanding({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    landing?: { $ref: string };
    recentSessions?: { $ref: string } | WorkspaceLandingSession[];
  };
  const landing = (() => {
    if (!props.landing) return null;
    const raw = resolvePointer(state, props.landing.$ref);
    if (!raw || typeof raw !== "object") return null;
    return raw as {
      kind?: string;
      projectId?: string;
      projectLabel?: string;
      hostId?: string;
      iconUrl?: string;
      workspaceId?: string;
      workspaceLabel?: string;
      branch?: string;
      path?: string;
      isMain?: boolean;
    };
  })();
  if (!landing || landing.kind !== "workspace") return null;

  const recentSessions = (() => {
    const raw = props.recentSessions;
    if (!raw) return [];
    const resolved = Array.isArray(raw) ? raw : resolvePointer(state, raw.$ref);
    if (!Array.isArray(resolved)) return [];
    const landingPath = normalizeLandingPath(landing.path);
    return (resolved as WorkspaceLandingSession[])
      .filter((session) => {
        if (!landingPath) return true;
        return normalizeLandingPath(session.cwd) === landingPath;
      })
      .slice(0, 8);
  })();

  const title = landing.workspaceLabel ?? landing.branch ?? "workspace";
  const projectLabel = landing.projectLabel ?? "";
  const branch = landing.branch ?? "";
  const path = landing.path ?? "";
  const isMain = landing.isMain === true;
  const sidebarIconUrl = projectIconUrlFromSidebar(state, landing.projectId);
  const iconUrl = sidebarIconUrl ?? landing.iconUrl;

  return (
    <WorkspaceLandingInner
      iconUrl={iconUrl}
      title={title}
      projectLabel={projectLabel}
      branch={branch}
      path={path}
      isMain={isMain}
      workspaceId={landing.workspaceId ?? null}
      projectId={landing.projectId ?? null}
      hostId={landing.hostId ?? null}
      recentSessions={recentSessions}
      onEvent={onEvent}
    />
  );
}

interface WorkspaceLandingSession {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
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

function normalizeLandingPath(path?: string): string {
  return (path ?? "").replace(/[/\\]+$/, "");
}

function WorkspaceLandingInner(props: {
  iconUrl?: string;
  title: string;
  projectLabel: string;
  branch: string;
  path: string;
  isMain: boolean;
  workspaceId: string | null;
  projectId: string | null;
  hostId: string | null;
  recentSessions: WorkspaceLandingSession[];
  onEvent: (
    name: string,
    data?: Record<string, unknown>,
    descendantId?: string,
  ) => void;
}) {
  const {
    iconUrl,
    title,
    projectLabel,
    branch,
    path,
    isMain,
    workspaceId,
    projectId,
    hostId,
    recentSessions,
    onEvent,
  } = props;
  const [gh, setGh] = useState<GhBranchStatus | null>(null);
  const [ghLoading, setGhLoading] = useState(false);

  // Fetch gh branch status whenever the active workspace changes. The
  // cache module short-circuits within-session revisits (60s TTL for
  // live repos, 5min for "no gh / no remote") so the landing paints
  // instantly on a tab flip. Failure is silent — Rust always returns
  // Ok with ghAvailable=false on any error path, so a missing/unauthed
  // gh just collapses to "Connect GitHub" in the UI.
  useEffect(() => {
    if (!branch || !path) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Clear stale GitHub status as soon as there is no branch to query.
      setGh(null);
      setGhLoading(false);
      return;
    }
    let cancelled = false;
    setGhLoading(true);
    void (
      hostId
        ? getGhBranchStatus(path, branch, hostId)
        : getGhBranchStatus(path, branch)
    )
      .then((status) => {
        if (cancelled) return;
        setGh(status);
      })
      .catch(() => {
        if (cancelled) return;
        setGh(null);
      })
      .finally(() => {
        if (!cancelled) setGhLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branch, hostId, path]);

  return (
    <div className="a2ui-empty-state a2ui-workspace-landing">
      <div className="a2ui-empty-state-card">
        <div className="a2ui-empty-state-hero" aria-hidden="true">
          {iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              className="a2ui-workspace-landing-icon"
              loading="lazy"
            />
          ) : (
            <AeMarkInline size={64} radius={12} />
          )}
        </div>
        <h1 className="a2ui-empty-state-title">{title}</h1>
        <p className="a2ui-empty-state-subtitle">
          {isMain ? "Main workspace of " : "Workspace of "}
          <strong>{projectLabel}</strong>
          {branch && (
            <>
              {" — "}
              <code>{branch}</code>
            </>
          )}
        </p>
        <p className="a2ui-empty-state-active-project">
          <span className="a2ui-empty-state-active-project-label">
            {branch || title}
          </span>
          <span className="a2ui-empty-state-active-project-path">{path}</span>
        </p>
        <div className="a2ui-empty-state-actions">
          <button
            type="button"
            className="a2ui-empty-state-primary"
            onClick={() =>
              onEvent("start-session", {
                workspaceId: workspaceId ?? undefined,
                projectId: projectId ?? undefined,
                hostId: props.hostId ?? undefined,
                path,
              })
            }
          >
            Start Session
          </button>
          <button
            type="button"
            className="a2ui-empty-state-secondary"
            onClick={() =>
              onEvent("open-workspace-in-finder", {
                workspaceId: workspaceId ?? undefined,
                projectId: projectId ?? undefined,
                hostId: props.hostId ?? undefined,
                path,
              })
            }
          >
            Open in Files
          </button>
        </div>
        {recentSessions.length > 0 && (
          <div className="a2ui-workspace-landing-sessions">
            <h2>Recent sessions</h2>
            <ul className="a2ui-workspace-landing-session-list">
              {recentSessions.map((session) => (
                <DashboardSessionRow
                  key={session.id}
                  session={session}
                  classPrefix="a2ui-workspace-landing"
                  onRestore={() =>
                    onEvent(
                      "restore-session",
                      {
                        sessionId: session.id,
                        label: session.label,
                        cwd: session.cwd,
                      },
                      session.id,
                    )
                  }
                  onDelete={() =>
                    onEvent(
                      "delete-session",
                      {
                        sessionId: session.id,
                        label: session.label,
                        confirmed: true,
                      },
                      session.id,
                    )
                  }
                />
              ))}
            </ul>
          </div>
        )}
        {/* Branch status via `gh` CLI. Silently absent when gh isn't
            installed/authed or the repo has no GitHub remote — the
            block just renders nothing (or "Not on GitHub" when we
            know gh is present but the repo isn't tracked). */}
        <GhBranchStatusBlock status={gh} loading={ghLoading} branch={branch} />
      </div>
    </div>
  );
}

function GhBranchStatusBlock(props: {
  status: GhBranchStatus | null;
  loading: boolean;
  branch: string;
}) {
  const { status, loading, branch } = props;
  if (loading) {
    return (
      <div className="a2ui-workspace-landing-gh">
        <h2>Branch status</h2>
        <p className="a2ui-empty-state-subtitle">Checking GitHub…</p>
      </div>
    );
  }
  // Surface a dangling workspace before the gh-availability check —
  // every git invocation in the dir would have failed, so this is the
  // accurate label, not "no GitHub remote".
  if (status?.workspaceBroken) {
    return (
      <div className="a2ui-workspace-landing-gh">
        <h2>Workspace status</h2>
        <p className="a2ui-empty-state-subtitle">
          This workspace is no longer tracked by git. Use the delete button in
          the sidebar to remove the leftover folder.
        </p>
      </div>
    );
  }
  // Silent fall-through when gh isn't available — don't show a noisy
  // "install gh" prompt. The landing should still feel useful without
  // the integration.
  if (!status || !status.ghAvailable) return null;
  if (!status.repo) {
    return (
      <div className="a2ui-workspace-landing-gh">
        <h2>Branch status</h2>
        <p className="a2ui-empty-state-subtitle">
          No GitHub remote detected for this workspace.
        </p>
      </div>
    );
  }
  const pushedLabel = status.pushed ? "Pushed to remote" : "Not pushed";
  return (
    <div className="a2ui-workspace-landing-gh">
      <h2>Branch status</h2>
      <ul className="a2ui-workspace-landing-gh-list">
        <li>
          <span className="a2ui-workspace-landing-gh-label">{status.repo}</span>
          <code>{branch}</code>
        </li>
        <li
          className={`a2ui-workspace-landing-gh-pushed${
            status.pushed ? " is-pushed" : ""
          }`}
        >
          {pushedLabel}
        </li>
        {status.prs.map((pr) => (
          <li key={pr.number} className="a2ui-workspace-landing-gh-pr">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              title={pr.title}
            >
              <span
                className={`a2ui-workspace-landing-gh-pr-state ae-pr-${
                  pr.merged ? "merged" : pr.state.toLowerCase()
                }`}
              >
                {pr.merged
                  ? "merged"
                  : pr.isDraft
                    ? "draft"
                    : pr.state.toLowerCase()}
              </span>
              <span className="a2ui-workspace-landing-gh-pr-number">
                #{pr.number}
              </span>
              <span className="a2ui-workspace-landing-gh-pr-title">
                {pr.title}
              </span>
            </a>
          </li>
        ))}
        {status.prs.length === 0 && (
          <li className="a2ui-empty-state-subtitle">No PRs for this branch.</li>
        )}
      </ul>
    </div>
  );
}
