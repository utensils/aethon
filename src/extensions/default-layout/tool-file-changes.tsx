import { useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { FileIcon } from "../../components/file-icon";
import { truncateDiffSnapshotContent } from "../../utils/editorDiffSnapshot";
import type {
  ToolCardFileChange,
  ToolMessageSummary,
} from "../../utils/toolCardGrouping";
import { Chevron } from "./sidebar/chevron";
import {
  basename,
  effectiveStats,
  fileChangeLabel,
  fileChangeStatsLabel,
  lineTone,
  looksLikeUnifiedDiff,
  parentPath,
  previewLines,
  summaryWithFileEntries,
  type ToolFileChangeEntry,
} from "./tool-activity-summary";

export function FileChangeStats({
  summary,
  hideLabel = false,
}: {
  summary: ToolMessageSummary;
  hideLabel?: boolean;
}) {
  const label = fileChangeLabel(summary);
  if (!label) return null;
  const { additions, deletions } = summary.fileChanges;
  return (
    <span className="ae-turn-block-files">
      {!hideLabel ? (
        <span className="ae-turn-block-files-label">{label}</span>
      ) : null}
      {additions > 0 ? (
        <span className="ae-turn-block-add">+{additions}</span>
      ) : null}
      {additions > 0 && deletions > 0 ? " " : null}
      {deletions > 0 ? (
        <span className="ae-turn-block-del">-{deletions}</span>
      ) : null}
    </span>
  );
}

export function ToolFileChangeRow({
  change,
  onEvent,
  componentId,
}: {
  change: ToolCardFileChange;
  onEvent?: BuiltinComponentProps["onEvent"];
  componentId?: string;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const filePath = change.path ?? "";
  if (!filePath) return null;
  const { additions, deletions } = effectiveStats(change);
  const dir = parentPath(filePath);
  const capturedDiff = looksLikeUnifiedDiff(change.preview)
    ? change.preview
    : "";
  const eventPayload = {
    filePath,
    ...(change.rootPath ? { rootPath: change.rootPath } : {}),
    ...(capturedDiff
      ? {
          diffSnapshot: {
            format: "unified",
            content: truncateDiffSnapshotContent(capturedDiff),
            ...(additions > 0 ? { additions } : {}),
            ...(deletions > 0 ? { deletions } : {}),
            source: "tool-card",
          },
        }
      : {}),
  };
  const togglePreview = () => {
    setPreviewOpen((open) => !open);
  };
  return (
    <div className="ae-tool-activity-file-item">
      <div className="ae-tool-activity-file">
        <button
          type="button"
          className="ae-tool-activity-file-open"
          title={`Open diff for ${filePath}`}
          onClick={() => onEvent?.("tool-file-diff", eventPayload, componentId)}
        >
          <FileIcon
            path={filePath}
            isDir={false}
            className="ae-tool-activity-file-icon"
          />
          <span className="ae-tool-activity-file-name">
            {basename(filePath)}
          </span>
          {dir ? (
            <span className="ae-tool-activity-file-dir">{dir}</span>
          ) : null}
        </button>
        {(additions > 0 || deletions > 0) && (
          <span
            className="ae-tool-activity-file-stat"
            aria-label="Line changes"
          >
            {additions > 0 ? (
              <span className="ae-turn-block-add">+{additions}</span>
            ) : null}
            {deletions > 0 ? (
              <span className="ae-turn-block-del">-{deletions}</span>
            ) : null}
          </span>
        )}
        <button
          type="button"
          className="ae-tool-activity-file-source"
          title={`Open ${filePath}`}
          aria-label={`Open ${basename(filePath)}`}
          onClick={() => onEvent?.("tool-file-open", eventPayload, componentId)}
        >
          Open
        </button>
        {capturedDiff ? (
          <button
            type="button"
            className="ae-tool-activity-file-preview-toggle"
            title={`${previewOpen ? "Hide" : "Show"} inline diff for ${filePath}`}
            aria-label={`${previewOpen ? "Hide" : "Show"} inline diff for ${basename(filePath)}`}
            aria-expanded={previewOpen}
            onClick={togglePreview}
          >
            <Chevron expanded={previewOpen} />
          </button>
        ) : null}
      </div>
      {previewOpen && capturedDiff ? (
        <pre className="ae-tool-file-diff-preview ae-tool-activity-file-preview">
          <code>
            {previewLines(capturedDiff).map((line, index) => (
              <span
                key={`${index}-${line}`}
                className={`ae-tool-file-diff-line is-${lineTone(line)}`}
              >
                <span className="ae-tool-file-diff-lineno">{index + 1}</span>
                <span className="ae-tool-file-diff-text">{line || " "}</span>
              </span>
            ))}
          </code>
        </pre>
      ) : previewOpen ? (
        <div className="ae-tool-activity-file-preview-empty">
          No stored diff snapshot is available for this tool record.
        </div>
      ) : null}
    </div>
  );
}

export function ToolFileChangesCard({
  entries,
  summary,
  onEvent,
}: {
  entries: ToolFileChangeEntry[];
  summary: ToolMessageSummary;
  onEvent?: BuiltinComponentProps["onEvent"];
}) {
  const label = fileChangeLabel(summary);
  if (entries.length === 0) return null;
  const displaySummary = summaryWithFileEntries(summary, entries);
  const statLabel = fileChangeStatsLabel(displaySummary);
  return (
    <div className="ae-file-activity-card" role="group" aria-label={statLabel}>
      <div className="ae-file-activity-head">
        <span className="ae-file-activity-icon" aria-hidden="true">
          ✎
        </span>
        <span className="ae-file-activity-title">{label}</span>
        <FileChangeStats summary={displaySummary} hideLabel />
      </div>
      <div className="ae-file-activity-list">
        {entries.map(({ change, componentId }) => (
          <ToolFileChangeRow
            key={`${componentId ?? ""}:${change.path}`}
            change={change}
            onEvent={onEvent}
            componentId={componentId}
          />
        ))}
      </div>
    </div>
  );
}
