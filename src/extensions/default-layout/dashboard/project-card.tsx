/**
 * project-card — tile for the projects-dashboard grid.
 *
 * Props:
 *   - project: { id, label, path, gitStatus? } — required, $ref or inline.
 *   - active?: boolean — highlight when this is the active project.
 *
 * Behaviour:
 *   - On first IntersectionObserver entry, lazily calls
 *     `getRepoOverview(path)` so the projects dashboard doesn't fire 16
 *     subprocesses on cold start. Re-fetches are cache-deduped.
 *   - Click → `"select-project-card"` event with `{ projectId, path }`.
 *   - Right-click → context menu via a "request-card-menu" event so the
 *     dashboard can show a shared context menu primitive.
 *
 * Registered as a chrome composite so an extension can swap it via
 * `aethon.registerComponent("project-card", MyCard)`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";
import {
  getRepoOverview,
  peekRepoOverview,
  type GhRepoOverview,
} from "../../../ghRepoOverviewCache";
import type { GitStatus } from "../../../hooks/useProjects";

interface ProjectCardData {
  id: string;
  remoteId?: string;
  label: string;
  path: string;
  hostId?: string;
  active?: boolean;
  gitStatus?: GitStatus | null;
  iconUrl?: string;
}

/** Deterministic accent color from the project id so the initial-tile
 *  fallback feels intentional rather than random. Pulls from a small
 *  palette of theme-friendly hues. */
function initialTileColor(id: string): string {
  const palette = [
    "#c45f3b",
    "#3b88c4",
    "#5fa847",
    "#9b6fc9",
    "#c98c2b",
    "#469da3",
    "#b73c87",
    "#6c7a89",
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function isCardRef(v: unknown): v is { $ref: string } {
  return typeof v === "object" && v !== null && "$ref" in (v);
}

function isProjectCardData(v: unknown): v is ProjectCardData {
  return (
    typeof v === "object" &&
    v !== null &&
    "id" in (v) &&
    "label" in (v) &&
    "path" in (v)
  );
}

export function ProjectCard({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as
    | { project?: unknown; active?: unknown }
    | undefined;

  const project: ProjectCardData | null = useMemo(() => {
    const raw = props?.project;
    if (!raw) return null;
    if (isCardRef(raw)) {
      const resolved = resolvePointer(state, raw.$ref);
      return isProjectCardData(resolved) ? resolved : null;
    }
    return isProjectCardData(raw) ? raw : null;
  }, [props?.project, state]);

  const active = typeof props?.active === "boolean" ? props.active : false;
  const containerRef = useRef<HTMLButtonElement | null>(null);
  const [overview, setOverview] = useState<GhRepoOverview | null>(() =>
    project
      ? project.hostId
        ? peekRepoOverview(project.path, project.hostId)
        : peekRepoOverview(project.path)
      : null,
  );
  const [overviewLoading, setOverviewLoading] = useState(false);

  useEffect(() => {
    if (!project) return;
    if (overview) return; // cached or already loaded
    const node = containerRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      // SSR / jsdom safety — just fetch eagerly.
      void (async () => {
        setOverviewLoading(true);
        try {
          const o = project.hostId
            ? await getRepoOverview(project.path, project.hostId)
            : await getRepoOverview(project.path);
          setOverview(o);
        } finally {
          setOverviewLoading(false);
        }
      })();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            io.disconnect();
            void (async () => {
              setOverviewLoading(true);
              try {
                const o = project.hostId
                  ? await getRepoOverview(project.path, project.hostId)
                  : await getRepoOverview(project.path);
                setOverview(o);
              } finally {
                setOverviewLoading(false);
              }
            })();
            break;
          }
        }
      },
      { rootMargin: "100px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [project, overview]);

  if (!project) return null;

  const { gitStatus } = project;
  const branch = gitStatus?.branch ?? "—";
  const dirty = gitStatus?.dirty === true;
  const ahead = gitStatus?.ahead ?? 0;
  const behind = gitStatus?.behind ?? 0;

  const ghReady = overview?.ghAvailable && overview?.repo;
  const openIssues = ghReady ? overview.openIssuesCount : null;
  const openPrs = ghReady ? overview.openPrsCount : null;

  return (
    <button
      ref={containerRef}
      type="button"
      className={
        "a2ui-project-card" + (active ? " a2ui-project-card--active" : "")
      }
      onClick={() =>
        onEvent(
          "select-project-card",
          {
            projectId: project.id,
            remoteId: project.remoteId,
            hostId: project.hostId,
            label: project.label,
            path: project.path,
          },
          project.id,
        )
      }
      onContextMenu={(e) => {
        e.preventDefault();
        onEvent(
          "request-card-menu",
          {
            projectId: project.id,
            path: project.path,
            x: e.clientX,
            y: e.clientY,
          },
          project.id,
        );
      }}
      title={project.path}
    >
      <div className="a2ui-project-card-head">
        {project.iconUrl ? (
          <img
            src={project.iconUrl}
            alt=""
            aria-hidden="true"
            className="a2ui-project-card-icon"
            loading="lazy"
          />
        ) : (
          <span
            className="a2ui-project-card-icon a2ui-project-card-icon--initial"
            aria-hidden="true"
            style={{ backgroundColor: initialTileColor(project.id) }}
          >
            {project.label.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="a2ui-project-card-label">{project.label}</span>
        {active && (
          <span className="a2ui-project-card-active-chip">active</span>
        )}
      </div>
      <div className="a2ui-project-card-path">{project.path}</div>
      <div className="a2ui-project-card-row">
        <span
          className={
            "a2ui-project-card-branch" +
            (dirty ? " a2ui-project-card-branch--dirty" : "")
          }
        >
          <span aria-hidden="true">⎇</span> {branch}
          {dirty && <span className="a2ui-project-card-dot" aria-label="dirty" />}
          {ahead > 0 && (
            <span className="a2ui-project-card-ahead">↑{ahead}</span>
          )}
          {behind > 0 && (
            <span className="a2ui-project-card-behind">↓{behind}</span>
          )}
        </span>
        <span className="a2ui-project-card-gh">
          {overviewLoading && !overview && (
            <span className="a2ui-project-card-gh-loading">…</span>
          )}
          {ghReady && (
            <>
              <span title="Open issues">● {openIssues}</span>
              <span title="Open PRs">⇡ {openPrs}</span>
            </>
          )}
        </span>
      </div>
    </button>
  );
}
