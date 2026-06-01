/**
 * ImageViewer — fallback editor surface for image extensions.
 *
 * The `fs_read_file` Tauri command is UTF-8-only by design (Monaco
 * needs faithful round-trip on the text path), so binary files come
 * back through `fs_read_file_base64` instead. The viewer turns the
 * resulting base64 into a data URI and renders it in an `<img>`.
 * Pan / zoom via the browser's native scroll + Cmd+= zoom for now;
 * a dedicated zoom UI can come later.
 *
 * Registered as `image-viewer` in the file-viewer registry. The
 * EditorCanvas resolves the registered component type and mounts it
 * inside the canvas grid area so the file-tree open-file flow
 * "just works" for any extension declared in the registry.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";

interface ImageViewerProps {
  filePath: string;
  projectPath: string;
}

function extensionToMime(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = base.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "avif":
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImageViewer(props: BuiltinComponentProps) {
  const componentProps = (props.component.props as Partial<ImageViewerProps>) ?? {};
  const filePath = componentProps.filePath ?? "";
  const projectPath = componentProps.projectPath ?? "";
  const [src, setSrc] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [size, setSize] = useState<number>(0);

  useEffect(() => {
    if (!filePath) return;
    if (!projectPath) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Clear stale image state immediately when the backing file changes.
    setSrc("");
    setError("");
    void invoke<string>("fs_read_file_base64", {
      root: projectPath,
      path: filePath,
    })
      .then((b64) => {
        if (cancelled) return;
        const mime = extensionToMime(filePath);
        setSrc(`data:${mime};base64,${b64}`);
        // Each base64 char encodes 6 bits → 4 chars per 3 input bytes.
        setSize(Math.floor((b64.length * 3) / 4));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, projectPath]);

  return (
    <div className="ae-image-viewer" style={{ gridArea: "canvas" }}>
      <div className="ae-image-viewer-stage">
        {error ? (
          <div className="ae-image-viewer-error">
            Failed to load image: {error}
          </div>
        ) : src ? (
          <img
            className="ae-image-viewer-img"
            src={src}
            alt={filePath}
            draggable={false}
          />
        ) : (
          <div className="ae-image-viewer-loading">loading…</div>
        )}
      </div>
      <div className="ae-image-viewer-status">
        <span className="ae-image-viewer-path" title={filePath}>
          {filePath}
        </span>
        <span className="ae-image-viewer-spacer" />
        {size > 0 && <span>{formatBytes(size)}</span>}
      </div>
    </div>
  );
}
