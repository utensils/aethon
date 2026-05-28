/**
 * gh-stats-strip — horizontal row of repo-level GitHub stats.
 *
 * Props:
 *   - overview: { $ref } | GhRepoOverview | null
 *     Resolves to a GhRepoOverview shape (see ghRepoOverviewCache.ts).
 *     null / no data renders nothing.
 *
 * Events:
 *   - "open-url" with `{ url }` — emitted when any link-bearing pill is
 *     clicked (repo header, issues count, PRs count, default branch).
 *     The dashboard event route translates these into shell-out via
 *     tauri-plugin-opener.
 *
 * Registered as a chrome composite so an extension can swap it via
 * `aethon.registerComponent("gh-stats-strip", MyStats)`.
 */
import { useMemo } from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";
import type { GhRepoOverview } from "../../../ghRepoOverviewCache";

interface OverviewRef {
  $ref: string;
}

function isOverviewRef(v: unknown): v is OverviewRef {
  return typeof v === "object" && v !== null && "$ref" in (v);
}

function isOverview(v: unknown): v is GhRepoOverview {
  return (
    typeof v === "object" &&
    v !== null &&
    "ghAvailable" in (v) &&
    "stargazerCount" in (v)
  );
}

function formatRelativeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function GhStatsStrip({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const overviewProp = (component.props as { overview?: unknown } | undefined)
    ?.overview;
  const overview: GhRepoOverview | null = useMemo(() => {
    if (!overviewProp) return null;
    if (isOverviewRef(overviewProp)) {
      const resolved = resolvePointer(state, overviewProp.$ref);
      return isOverview(resolved) ? resolved : null;
    }
    return isOverview(overviewProp) ? overviewProp : null;
  }, [overviewProp, state]);

  if (!overview || !overview.ghAvailable || !overview.repo) return null;

  const openUrl = (url: string | null | undefined) => {
    if (!url) return;
    onEvent("open-url", { url });
  };

  return (
    <div
      className="a2ui-gh-stats-strip"
      role="group"
      aria-label="GitHub repository stats"
    >
      <button
        type="button"
        className="a2ui-gh-stat a2ui-gh-stat--repo"
        onClick={() => openUrl(overview.url)}
        title={`Open ${overview.repo} on GitHub`}
      >
        <span className="a2ui-gh-stat-icon" aria-hidden="true">
          ⌥
        </span>
        <span className="a2ui-gh-stat-value">{overview.repo}</span>
      </button>
      <button
        type="button"
        className="a2ui-gh-stat"
        onClick={() => openUrl(overview.url)}
        title="Stargazers"
      >
        <span className="a2ui-gh-stat-icon" aria-hidden="true">
          ★
        </span>
        <span className="a2ui-gh-stat-value">{overview.stargazerCount}</span>
        <span className="a2ui-gh-stat-label">stars</span>
      </button>
      <button
        type="button"
        className="a2ui-gh-stat"
        onClick={() => openUrl(overview.url ? `${overview.url}/network/members` : null)}
        title="Forks"
      >
        <span className="a2ui-gh-stat-icon" aria-hidden="true">
          ⑂
        </span>
        <span className="a2ui-gh-stat-value">{overview.forkCount}</span>
        <span className="a2ui-gh-stat-label">forks</span>
      </button>
      <button
        type="button"
        className="a2ui-gh-stat"
        onClick={() =>
          openUrl(overview.url ? `${overview.url}/issues` : null)
        }
        title="Open issues"
      >
        <span className="a2ui-gh-stat-icon" aria-hidden="true">
          ●
        </span>
        <span className="a2ui-gh-stat-value">{overview.openIssuesCount}</span>
        <span className="a2ui-gh-stat-label">issues</span>
      </button>
      <button
        type="button"
        className="a2ui-gh-stat"
        onClick={() => openUrl(overview.url ? `${overview.url}/pulls` : null)}
        title="Open pull requests"
      >
        <span className="a2ui-gh-stat-icon" aria-hidden="true">
          ⇡
        </span>
        <span className="a2ui-gh-stat-value">{overview.openPrsCount}</span>
        <span className="a2ui-gh-stat-label">PRs</span>
      </button>
      {overview.defaultBranch && (
        <span className="a2ui-gh-stat a2ui-gh-stat--branch">
          <span className="a2ui-gh-stat-icon" aria-hidden="true">
            ⎇
          </span>
          <span className="a2ui-gh-stat-value">{overview.defaultBranch}</span>
        </span>
      )}
      {overview.pushedAt && (
        <span
          className="a2ui-gh-stat a2ui-gh-stat--pushed"
          title={overview.pushedAt}
        >
          <span className="a2ui-gh-stat-icon" aria-hidden="true">
            ⏱
          </span>
          <span className="a2ui-gh-stat-value">
            {formatRelativeAgo(overview.pushedAt)}
          </span>
        </span>
      )}
    </div>
  );
}
