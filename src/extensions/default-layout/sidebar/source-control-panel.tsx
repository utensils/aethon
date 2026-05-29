/**
 * SourceControlPanel — a rich VCS summary mounted above the file tree in
 * the files sidebar. Reads the `/vcs` slice populated by `useVcsStatus`:
 *   - branch + ahead/behind
 *   - working-tree change breakdown with an expandable changed-file list
 *     (click a file → opens it in an editor tab)
 *   - PR card (click → opens GitHub)
 *   - CI rollup with an expandable per-job list (click the row → toggles
 *     the jobs; click a job → opens that check on GitHub). Auto-expands
 *     when the rollup is failing. Falls back to open-on-click when the
 *     rollup carries no individual check runs.
 *
 * Render-only: all data + polling lives in `useVcsStatus`. Hidden entirely
 * when the active root is not a git repo so the file tree keeps its space.
 */
import { useRef, useState } from "react";

import { FileIcon } from "../../../components/file-icon";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { VcsSlice } from "../../../hooks/useVcsStatus";
import { resolvePointer } from "../../../utils/jsonPointer";
import { GIT_STATUS_META, absolutePathFor, basename } from "./fileTreeModel";
import {
  changeBreakdown,
  checkRunMeta,
  ciMeta,
  prMeta,
  sortChecks,
} from "./vcs-presentation";

export function SourceControlPanel({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as { source?: { $ref: string } };
  const vcs =
    (props.source && "$ref" in props.source
      ? (resolvePointer(state, props.source.$ref) as VcsSlice | undefined)
      : (resolvePointer(state, "/vcs") as VcsSlice | undefined)) ?? undefined;

  const [filesOpen, setFilesOpen] = useState(true);

  // CI job list expand state. Auto-expands on failure; a manual toggle wins
  // until the rollup conclusion flips (reset via the guarded set below).
  const ciConclusion = vcs?.ci?.conclusion ?? null;
  const [ciOverride, setCiOverride] = useState<boolean | null>(null);
  const prevConclusion = useRef(ciConclusion);
  if (prevConclusion.current !== ciConclusion) {
    prevConclusion.current = ciConclusion;
    setCiOverride(null);
  }

  // Not a git repo → render nothing so the file tree gets the full column.
  if (!vcs || (!vcs.branch && vcs.changes.total === 0) || !vcs.root) {
    return null;
  }

  const { changes, root } = vcs;
  const pr = prMeta(vcs.pr);
  const ci = ciMeta(vcs.ci);
  const breakdown = changeBreakdown(changes);

  const openUrl = (url: string | undefined | null) => {
    if (url) onEvent("open-url", { url });
  };
  const ciUrl =
    vcs.ci?.checks.find((c) => c.conclusion === "failure")?.url ??
    vcs.ci?.checks[0]?.url ??
    vcs.pr?.url ??
    null;
  const hasChecks = (vcs.ci?.checks.length ?? 0) > 0;
  const ciOpen = ciOverride ?? ciConclusion === "failure";

  return (
    <section
      className="ae-scm-panel"
      aria-label="Source control"
      data-loading={vcs.loading ? "true" : undefined}
    >
      <div className="ae-scm-titlebar">
        <span className="ae-scm-title">Source control</span>
        {vcs.branch ? (
          <span className="ae-scm-branch" title={`On branch ${vcs.branch}`}>
            <span className="ae-scm-branch-glyph" aria-hidden="true">
              ⎇
            </span>
            <span className="ae-scm-branch-name">{vcs.branch}</span>
            {vcs.ahead > 0 ? (
              <span className="ae-scm-aheadbehind">↑{vcs.ahead}</span>
            ) : null}
            {vcs.behind > 0 ? (
              <span className="ae-scm-aheadbehind">↓{vcs.behind}</span>
            ) : null}
          </span>
        ) : null}
      </div>

      {pr && vcs.pr ? (
        <button
          type="button"
          className={`ae-scm-row ae-scm-pr is-${pr.tone}`}
          title={`${pr.title} — open on GitHub`}
          onClick={() => openUrl(vcs.pr?.url)}
        >
          <span className="ae-scm-row-glyph" aria-hidden="true">
            ⊶
          </span>
          <span className="ae-scm-row-label">
            PR #{vcs.pr.number}
            <span className="ae-scm-row-sub">{vcs.pr.title}</span>
          </span>
          <span className={`ae-scm-badge is-${pr.tone}`}>{pr.label}</span>
        </button>
      ) : null}

      {ci ? (
        <div className="ae-scm-ci-group">
          <button
            type="button"
            className={`ae-scm-row ae-scm-ci is-${ci.tone}`}
            title={hasChecks ? `${ci.title} — show jobs` : ci.title}
            aria-expanded={hasChecks ? ciOpen : undefined}
            onClick={() =>
              hasChecks ? setCiOverride(!ciOpen) : openUrl(ciUrl)
            }
          >
            <span className={`ae-scm-ci-icon is-${ci.tone}`} aria-hidden="true">
              {ci.icon}
            </span>
            <span className="ae-scm-row-label">
              CI
              <span className="ae-scm-row-sub">{ci.label}</span>
            </span>
            {vcs.ci ? (
              <span className="ae-scm-ci-count">
                {vcs.ci.passed}/{vcs.ci.total}
              </span>
            ) : null}
            {hasChecks ? (
              <span
                className="ae-scm-chevron ae-scm-ci-chevron"
                aria-hidden="true"
              >
                {ciOpen ? "▾" : "▸"}
              </span>
            ) : null}
          </button>
          {ciOpen && hasChecks ? (
            <ul className="ae-scm-checks-list">
              {sortChecks(vcs.ci?.checks ?? []).map((run) => {
                const meta = checkRunMeta(run);
                const clickable = Boolean(run.url);
                return (
                  <li
                    key={run.name}
                    className={`ae-scm-check is-${meta.tone}`}
                    data-clickable={clickable ? "true" : undefined}
                    title={
                      clickable
                        ? `${run.name} — ${meta.label} · open on GitHub`
                        : `${run.name} — ${meta.label}`
                    }
                    onClick={clickable ? () => openUrl(run.url) : undefined}
                  >
                    <span
                      className={`ae-scm-check-icon is-${meta.tone}`}
                      aria-hidden="true"
                    >
                      {meta.icon}
                    </span>
                    <span className="ae-scm-check-name">{run.name}</span>
                    <span className={`ae-scm-check-status is-${meta.tone}`}>
                      {meta.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {changes.total > 0 ? (
        <div className="ae-scm-changes">
          <button
            type="button"
            className="ae-scm-changes-header"
            aria-expanded={filesOpen}
            onClick={() => setFilesOpen((o) => !o)}
          >
            <span className="ae-scm-chevron" aria-hidden="true">
              {filesOpen ? "▾" : "▸"}
            </span>
            <span className="ae-scm-changes-count">
              {changes.total} changed
            </span>
            {breakdown ? (
              <span className="ae-scm-changes-breakdown">{breakdown}</span>
            ) : null}
          </button>
          {filesOpen ? (
            <ul className="ae-scm-file-list">
              {changes.files.map((f) => {
                const meta = GIT_STATUS_META[f.status];
                return (
                  <li
                    key={f.path}
                    className={`ae-scm-file git-status-${f.status}`}
                    title={`${f.path} — ${meta?.title ?? f.status}`}
                    onClick={() =>
                      onEvent("file-tree-diff", {
                        filePath: absolutePathFor(root, f.path),
                        rootPath: root,
                      })
                    }
                  >
                    <FileIcon
                      path={f.path}
                      isDir={false}
                      className="ae-scm-file-icon"
                    />
                    <span className="ae-scm-file-name">{basename(f.path)}</span>
                    <span className="ae-scm-file-path">{f.path}</span>
                    <span
                      className={`ae-scm-file-status git-status-${f.status}`}
                      aria-label={meta?.title ?? f.status}
                    >
                      {meta?.label ?? "•"}
                    </span>
                  </li>
                );
              })}
              {changes.total > changes.files.length ? (
                <li className="ae-scm-file-more">
                  +{changes.total - changes.files.length} more
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="ae-scm-clean">Working tree clean</div>
      )}
    </section>
  );
}
