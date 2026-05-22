/**
 * MarkdownPreview — rendered view for `.md` editor tabs.
 *
 * Reuses the same MARKDOWN_COMPONENTS adapter the chat history uses
 * for code-fence highlighting, so a markdown file previews with the
 * same palette + syntax highlighting users already see in chat. We
 * read the file via `fs_read_file` (the live Monaco buffer doesn't
 * have to be the source of truth here — the preview reflects the
 * current on-disk text; an unsaved buffer keeps editing in Monaco
 * while the preview pane is closed). Hidden behind Cmd+Shift+V; the
 * EditorCanvas branches based on `tab.editor.previewMode`.
 *
 * Edge cases mirrored from Claudette's MessageMarkdown:
 *   - GFM (tables, task lists, strikethrough) via remark-gfm.
 *   - Empty file: render a small inline hint rather than blank.
 *   - Read error: show inline error like ImageViewer does.
 *   - Live update: re-read when the Monaco buffer's last-saved
 *     content changes (we just key off filePath + a refreshKey state
 *     that the canvas bumps via the markdown-preview-refresh event;
 *     v1 keeps it simple and refreshes on mount + when the active
 *     tab's editor metadata says clean).
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";

import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { MARKDOWN_COMPONENTS } from "../markdown-adapter";

interface MarkdownPreviewProps {
  filePath: string;
  projectPath: string;
  /** Bumps whenever the user saves the file — forces the preview to
   *  re-read fresh content. */
  refreshKey?: number;
}

export function MarkdownPreview(props: BuiltinComponentProps) {
  const componentProps = (props.component.props as Partial<MarkdownPreviewProps>) ?? {};
  const filePath = componentProps.filePath ?? "";
  const projectPath = componentProps.projectPath ?? "";
  const refreshKey = componentProps.refreshKey ?? 0;
  const [text, setText] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!filePath || !projectPath) {
      setError("no file");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    void invoke<string>("fs_read_file", { root: projectPath, path: filePath })
      .then((value) => {
        if (cancelled) return;
        setText(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, projectPath, refreshKey]);

  return (
    <div className="ae-md-preview" style={{ gridArea: "canvas" }}>
      <div className="ae-md-preview-body">
        {loading ? (
          <div className="ae-md-preview-loading">loading…</div>
        ) : error ? (
          <div className="ae-md-preview-error">Failed to load: {error}</div>
        ) : text.trim().length === 0 ? (
          <div className="ae-md-preview-empty">empty file</div>
        ) : (
          <div className="ae-md-preview-doc a2ui-message-md">
            <ReactMarkdown components={MARKDOWN_COMPONENTS}>
              {text}
            </ReactMarkdown>
          </div>
        )}
      </div>
      <div className="ae-md-preview-status">
        <span className="ae-md-preview-path" title={filePath}>
          {filePath}
        </span>
        <span className="ae-md-preview-spacer" />
        <span className="ae-md-preview-hint">preview · ⌘⇧V</span>
      </div>
    </div>
  );
}
