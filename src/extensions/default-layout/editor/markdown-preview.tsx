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
 *   - README-safe raw HTML (logos/headings/badges) via rehype-raw + sanitize.
 *   - Empty file: render a small inline hint rather than blank.
 *   - Read error: show inline error like ImageViewer does.
 *   - Live update: re-read when the Monaco buffer's last-saved
 *     content changes (we just key off filePath + a refreshKey state
 *     that the canvas bumps via the markdown-preview-refresh event;
 *     v1 keeps it simple and refreshes on mount + when the active
 *     tab's editor metadata says clean).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import {
  MARKDOWN_PREVIEW_PROPS,
  safeMarkdownImageSrc,
} from "../markdown-adapter";
import { resolveMarkdownLinkPath, safeExternalHttpUrl } from "./markdown-links";

interface MarkdownPreviewProps {
  filePath: string;
  projectPath: string;
  /** The editor tab this preview belongs to — needed so the Edit button
   *  routes the preview-toggle event back to the right tab. */
  tabId?: string;
  /** Bumps whenever the user saves the file — forces the preview to
   *  re-read fresh content. */
  refreshKey?: number;
}

function openExternalUrl(url: string): void {
  try {
    void openUrl(url).catch(() => undefined);
  } catch {
    // Opener failures are not actionable from preview rendering.
  }
}

function imageMimeFromPath(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  switch (base.slice(dot + 1).toLowerCase()) {
    case "apng":
      return "image/apng";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "ico":
      return "image/x-icon";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function PreviewMarkdownImage({
  src,
  alt,
  node,
  currentFilePath,
  projectPath,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement> & {
  currentFilePath: string;
  projectPath: string;
  node?: unknown;
}) {
  void node;
  const [resolvedLocalSrc, setResolvedLocalSrc] = useState<{
    key: string;
    src: string;
  } | null>(null);
  const safeDirectSrc = safeMarkdownImageSrc(src);
  const imagePath = safeDirectSrc
    ? null
    : resolveMarkdownLinkPath(src, currentFilePath, projectPath);
  const localImageKey =
    imagePath && projectPath ? `${projectPath}\0${imagePath}` : "";

  useEffect(() => {
    if (!imagePath || !projectPath || !localImageKey) return;

    let cancelled = false;
    void invoke<string>("fs_read_file_base64", {
      root: projectPath,
      path: imagePath,
    })
      .then((b64) => {
        if (cancelled) return;
        setResolvedLocalSrc({
          key: localImageKey,
          src: `data:${imageMimeFromPath(imagePath)};base64,${b64}`,
        });
      })
      .catch(() => {
        if (!cancelled) setResolvedLocalSrc({ key: localImageKey, src: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [imagePath, localImageKey, projectPath]);

  const imageSrc =
    safeDirectSrc ??
    (resolvedLocalSrc?.key === localImageKey ? resolvedLocalSrc.src : null);
  if (!imageSrc) return null;
  return <img {...rest} src={imageSrc} alt={alt ?? ""} />;
}

export function MarkdownPreview(props: BuiltinComponentProps) {
  const componentProps =
    (props.component.props as Partial<MarkdownPreviewProps>) ?? {};
  const filePath = componentProps.filePath ?? "";
  const projectPath = componentProps.projectPath ?? "";
  const tabId = componentProps.tabId ?? "";
  const refreshKey = componentProps.refreshKey ?? 0;
  const onEvent = props.onEvent;
  const linkEventContextRef = useRef({ tabId, onEvent });
  const loadedPreviewTargetRef = useRef<string>("");
  const [text, setText] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  useEffect(() => {
    linkEventContextRef.current = { tabId, onEvent };
  }, [onEvent, tabId]);
  const markdownLinkComponent = useMemo(() => {
    function MarkdownPreviewLink({
      children,
      href,
      node,
      ...rest
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
      void node;
      return (
        <a
          {...rest}
          href={href}
          onClick={(event) => {
            const targetPath = resolveMarkdownLinkPath(
              href,
              filePath,
              projectPath,
            );
            const externalUrl = safeExternalHttpUrl(href);
            if (!targetPath) {
              if (!externalUrl) return;
              event.preventDefault();
              event.stopPropagation();
              openExternalUrl(externalUrl);
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            const context = linkEventContextRef.current;
            if (!context.tabId) return;
            context.onEvent("markdown-link-open", {
              tabId: context.tabId,
              filePath: targetPath,
              rootPath: projectPath,
            });
          }}
        >
          {children}
        </a>
      );
    }
    return MarkdownPreviewLink;
  }, [filePath, projectPath]);
  const markdownImageComponent = useMemo(() => {
    function MarkdownPreviewImage({
      node,
      ...rest
    }: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
      return (
        <PreviewMarkdownImage
          {...rest}
          node={node}
          currentFilePath={filePath}
          projectPath={projectPath}
        />
      );
    }
    return MarkdownPreviewImage;
  }, [filePath, projectPath]);
  const markdownProps = useMemo<ReactMarkdownOptions>(() => {
    const components = {
      ...MARKDOWN_PREVIEW_PROPS.components,
      a: markdownLinkComponent,
      img: markdownImageComponent,
    };
    return { ...MARKDOWN_PREVIEW_PROPS, components };
  }, [markdownImageComponent, markdownLinkComponent]);

  useEffect(() => {
    if (!filePath || !projectPath) {
      loadedPreviewTargetRef.current = "";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reflect the missing-file state before any async preview load can run.
      setError("no file");
      setLoading(false);
      return;
    }
    let cancelled = false;
    const previewTarget = `${projectPath}\0${filePath}`;
    if (loadedPreviewTargetRef.current !== previewTarget) {
      setLoading(true);
    }
    setError("");
    void invoke<string>("fs_read_file", { root: projectPath, path: filePath })
      .then((value) => {
        if (cancelled) return;
        loadedPreviewTargetRef.current = previewTarget;
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
          <div className="ae-md-preview-doc a2ui-markdown">
            <ReactMarkdown {...markdownProps}>{text}</ReactMarkdown>
          </div>
        )}
      </div>
      <div className="ae-md-preview-status">
        <span className="ae-md-preview-path" title={filePath}>
          {filePath}
        </span>
        <span className="ae-md-preview-spacer" />
        <button
          type="button"
          className="ae-md-preview-edit"
          title="Back to editor (⌘⇧V)"
          aria-label="Back to editor"
          onClick={() => {
            if (tabId) props.onEvent("editor-preview-toggle", { tabId });
          }}
        >
          Edit · ⌘⇧V
        </button>
      </div>
    </div>
  );
}
