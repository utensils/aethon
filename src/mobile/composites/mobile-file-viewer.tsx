// Read-only file viewer overlay for the Files screen. Opens when
// `/mobileFileViewer/open` is set (a tap on a file row); fetches the
// content over the gateway's root-checked fs_read_file and shows it in a
// scrollable monospace pane. Read-only by design — editing on a phone is
// out of scope; this is for glancing at a file the agent touched.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

interface ViewerState {
  open?: boolean;
  root?: string;
  path?: string;
}

function fileName(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function MobileFileViewer({ state, onEvent }: BuiltinComponentProps) {
  const viewer = (state.mobileFileViewer as ViewerState | undefined) ?? {};
  const { open, root, path } = viewer;
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !root || !path) return;
    let cancelled = false;
    // Reset for the newly-opened file before the async read resolves —
    // a resync to the open/path deps, not ongoing effect state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContent(null);
    setError(null);
    invoke<string>("fs_read_file", { root, path })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, root, path]);

  if (!open || !path) return null;

  return (
    <div className="ae-mobile-viewer" role="dialog" aria-modal="true">
      <header className="ae-mobile-viewer-head">
        <span className="ae-mobile-viewer-name">{fileName(path)}</span>
        <button
          type="button"
          className="ae-mobile-viewer-close"
          aria-label="Close"
          onClick={() => onEvent("close")}
        >
          ×
        </button>
      </header>
      <div className="ae-mobile-viewer-body">
        {error ? (
          <p className="ae-mobile-viewer-error">{error}</p>
        ) : content === null ? (
          <p className="ae-mobile-viewer-loading">Loading…</p>
        ) : (
          <pre className="ae-mobile-viewer-pre">{content}</pre>
        )}
      </div>
    </div>
  );
}
