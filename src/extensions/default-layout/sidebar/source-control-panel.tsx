/**
 * SourceControlPanel — a rich VCS summary mounted above the file tree in
 * the files sidebar. Reads the `/vcs` slice populated by `useVcsStatus`:
 *   - branch + ahead/behind
 *   - working-tree change breakdown with an expandable changed-file list
 *     (click a file → opens it in an editor tab)
 *   - PR card (click → opens GitHub)
 *   - CI rollup (click → opens the failing/first check, or the PR)
 *
 * Render-only: all data + polling lives in `useVcsStatus`. Hidden entirely
 * when the active root is not a git repo so the file tree keeps its space.
 */
import { useState } from "react";

import { FileIcon } from "../../../components/file-icon";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { VcsSlice } from "../../../hooks/useVcsStatus";
import { resolvePointer } from "../../../utils/jsonPointer";
import { GIT_STATUS_META, absolutePathFor, basename } from "./fileTreeModel";
import { changeBreakdown, ciMeta, prMeta } from "./vcs-presentation";

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
        <button
          type="button"
          className={`ae-scm-row ae-scm-ci is-${ci.tone}`}
          title={ci.title}
          onClick={() => openUrl(ciUrl)}
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
        </button>
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
                      onEvent("file-tree-open", {
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
