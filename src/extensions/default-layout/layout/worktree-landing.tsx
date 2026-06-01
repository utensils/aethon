/**
 * `WorktreeLanding` — full-canvas landing shown when the user clicks a
 * worktree in the sidebar but hasn't yet started a session in it.
 * Mirrors `EmptyState`'s visual shape (AeMark hero + active-target chip
 * + CTAs) but scoped to a single worktree. The "Start Session" CTA
 * spawns a fresh agent tab whose cwd is the worktree's path; "Open in
 * Files" reveals it in the system file manager.
 *
 * Visibility is driven by `/landing/kind === "worktree"` — sidebar
 * emits the "switch-worktree" event which the app handles by writing
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

export function WorktreeLanding({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    landing?: { $ref: string };
    recentSessions?: { $ref: string } | WorktreeLandingSession[];
  };
  const landing = (() => {
    if (!props.landing) return null;
    const raw = resolvePointer(state, props.landing.$ref);
    if (!raw || typeof raw !== "object") return null;
    return raw as {
      kind?: string;
      projectId?: string;
      projectLabel?: string;
      iconUrl?: string;
      worktreeId?: string;
      worktreeLabel?: string;
      branch?: string;
      path?: string;
      isMain?: boolean;
    };
  })();
  if (!landing || landing.kind !== "worktree") return null;

  const recentSessions = (() => {
    const raw = props.recentSessions;
    if (!raw) return [];
    const resolved = Array.isArray(raw)
      ? raw
      : resolvePointer(state, raw.$ref);
    if (!Array.isArray(resolved)) return [];
    const landingPath = normalizeLandingPath(landing.path);
    return (resolved as WorktreeLandingSession[])
      .filter((session) => {
        if (!landingPath) return true;
        return normalizeLandingPath(session.cwd) === landingPath;
      })
      .slice(0, 8);
  })();

  const title = landing.worktreeLabel ?? landing.branch ?? "worktree";
  const projectLabel = landing.projectLabel ?? "";
  const branch = landing.branch ?? "";
  const path = landing.path ?? "";
  const isMain = landing.isMain === true;
  const sidebarIconUrl = projectIconUrlFromSidebar(state, landing.projectId);
  const iconUrl = sidebarIconUrl ?? landing.iconUrl;

  return (
    <WorktreeLandingInner
      iconUrl={iconUrl}
      title={title}
      projectLabel={projectLabel}
      branch={branch}
      path={path}
      isMain={isMain}
      worktreeId={landing.worktreeId ?? null}
      projectId={landing.projectId ?? null}
      recentSessions={recentSessions}
      onEvent={onEvent}
    />
  );
}

interface WorktreeLandingSession {
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

function WorktreeLandingInner(props: {
  iconUrl?: string;
  title: string;
  projectLabel: string;
  branch: string;
  path: string;
  isMain: boolean;
  worktreeId: string | null;
  projectId: string | null;
  recentSessions: WorktreeLandingSession[];
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
    worktreeId,
    projectId,
    recentSessions,
    onEvent,
  } = props;
  const [gh, setGh] = useState<GhBranchStatus | null>(null);
  const [ghLoading, setGhLoading] = useState(false);

  // Fetch gh branch status whenever the active worktree changes. The
  // cache module short-circuits within-session revisits (60s TTL for
  // live repos, 5min for "no gh / no remote") so the landing paints
  // instantly on a tab flip. Failure is silent — Rust always returns
  // Ok with ghAvailable=false on any error path, so a missing/unauthed
  // gh just collapses to "Connect GitHub" in the UI.
  useEffect(() => {
    if (!branch || !path) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Clear stale GitHub status as soon as there is no branch to query.
      setGh(null);
      return;
    }
    let cancelled = false;
    setGhLoading(true);
    void getGhBranchStatus(path, branch)
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
  }, [branch, path]);

  return (
    <div className="a2ui-empty-state a2ui-worktree-landing">
      <div className="a2ui-empty-state-card">
        <div className="a2ui-empty-state-hero" aria-hidden="true">
          {iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              className="a2ui-worktree-landing-icon"
              loading="lazy"
            />
          ) : (
            <AeMarkInline size={64} radius={12} />
          )}
        </div>
        <h1 className="a2ui-empty-state-title">{title}</h1>
        <p className="a2ui-empty-state-subtitle">
          {isMain ? "Main worktree of " : "Worktree of "}
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
                worktreeId: worktreeId ?? undefined,
                projectId: projectId ?? undefined,
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
              onEvent("open-worktree-in-finder", {
                worktreeId: worktreeId ?? undefined,
                projectId: projectId ?? undefined,
                path,
              })
            }
          >
            Open in Files
          </button>
        </div>
        {recentSessions.length > 0 && (
          <div className="a2ui-worktree-landing-sessions">
            <h2>Recent sessions</h2>
            <ul className="a2ui-worktree-landing-session-list">
              {recentSessions.map((session) => (
                <DashboardSessionRow
                  key={session.id}
                  session={session}
                  classPrefix="a2ui-worktree-landing"
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
      <div className="a2ui-worktree-landing-gh">
        <h2>Branch status</h2>
        <p className="a2ui-empty-state-subtitle">Checking GitHub…</p>
      </div>
    );
  }
  // Surface a dangling worktree before the gh-availability check —
  // every git invocation in the dir would have failed, so this is the
  // accurate label, not "no GitHub remote".
  if (status?.worktreeBroken) {
    return (
      <div className="a2ui-worktree-landing-gh">
        <h2>Worktree status</h2>
        <p className="a2ui-empty-state-subtitle">
          This worktree is no longer tracked by git. Use the delete
          button in the sidebar to remove the leftover folder.
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
      <div className="a2ui-worktree-landing-gh">
        <h2>Branch status</h2>
        <p className="a2ui-empty-state-subtitle">
          No GitHub remote detected for this worktree.
        </p>
      </div>
    );
  }
  const pushedLabel = status.pushed ? "Pushed to remote" : "Not pushed";
  return (
    <div className="a2ui-worktree-landing-gh">
      <h2>Branch status</h2>
      <ul className="a2ui-worktree-landing-gh-list">
        <li>
          <span className="a2ui-worktree-landing-gh-label">{status.repo}</span>
          <code>{branch}</code>
        </li>
        <li
          className={`a2ui-worktree-landing-gh-pushed${
            status.pushed ? " is-pushed" : ""
          }`}
        >
          {pushedLabel}
        </li>
        {status.prs.map((pr) => (
          <li key={pr.number} className="a2ui-worktree-landing-gh-pr">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              title={pr.title}
            >
              <span
                className={`a2ui-worktree-landing-gh-pr-state ae-pr-${
                  pr.merged ? "merged" : pr.state.toLowerCase()
                }`}
              >
                {pr.merged
                  ? "merged"
                  : pr.isDraft
                    ? "draft"
                    : pr.state.toLowerCase()}
              </span>
              <span className="a2ui-worktree-landing-gh-pr-number">
                #{pr.number}
              </span>
              <span className="a2ui-worktree-landing-gh-pr-title">
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
