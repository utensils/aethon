/**
 * DiffCanvas — read-only side-by-side diff surface for editor tabs whose
 * `editor.diff` flag is set (opened from the Source Control / CI panel's
 * "open changes" flow).
 *
 * Wraps Monaco's `createDiffEditor`: the original (left) side is the
 * file's content at HEAD (`git_show_head`), the modified (right) side is
 * the current working-tree content (`fs_read_file`). Both sides are
 * read-only in v1 — editing happens in the normal EditorCanvas, reachable
 * via the "Edit file" button (emits `editor-diff-to-edit`, which drops the
 * tab's diff flag).
 *
 * Theme handling mirrors EditorCanvas: apply on mount, re-apply once Shiki
 * binds, and observe `data-theme` for live theme switches. Models are
 * created per load and disposed on swap/unmount so they don't leak.
 */

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";

import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { applyMonacoTheme } from "../../../monaco/theme";
import { ensureShikiMonacoReady } from "../../../monaco/shiki";
import { languageFromPath } from "../../../monaco/language-detection";
import { compressPath } from "./path";

interface DiffCanvasProps {
  filePath: string;
  projectPath: string;
  tabId?: string;
  /** Changes to force a re-read (e.g. after the working tree changes). A
   *  string signature (count + diff stat) so editing the same file and
   *  saving — which leaves the changed-file *count* unchanged — still
   *  refreshes the diff. */
  refreshKey?: number | string;
}

function disposeModels(
  pair: monaco.editor.IDiffEditorModel | null | undefined,
): void {
  pair?.original?.dispose();
  pair?.modified?.dispose();
}

export function DiffCanvas(props: BuiltinComponentProps) {
  const cp = (props.component.props as Partial<DiffCanvasProps>) ?? {};
  const filePath = cp.filePath ?? "";
  const projectPath = cp.projectPath ?? "";
  const tabId = cp.tabId ?? "";
  const refreshKey = cp.refreshKey ?? 0;

  const containerRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [error, setError] = useState<string>("");

  // ─── Mount the diff editor for the lifetime of this component ───────
  useEffect(() => {
    if (!containerRef.current) return;
    applyMonacoTheme(document.documentElement.dataset.theme);
    void ensureShikiMonacoReady()
      .then(() => applyMonacoTheme(document.documentElement.dataset.theme))
      .catch(() => {
        /* fall back to Monaco's built-in tokenisation */
      });

    const ed = monaco.editor.createDiffEditor(containerRef.current, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      ignoreTrimWhitespace: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      // Keep both panes visually symmetric: no minimap, no per-side diff
      // overview ruler (the asymmetric colored band), and identical
      // scrollbar gutters left and right.
      minimap: { enabled: false },
      renderOverviewRuler: false,
      scrollbar: {
        verticalScrollbarSize: 12,
        horizontalScrollbarSize: 12,
        verticalSliderSize: 12,
      },
      overviewRulerLanes: 0,
      scrollBeyondLastLine: false,
    });
    diffRef.current = ed;

    return () => {
      const pair = ed.getModel();
      ed.dispose();
      disposeModels(pair);
      diffRef.current = null;
    };
  }, []);

  // ─── React to theme changes after mount ────────────────────────────
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => applyMonacoTheme(root.dataset.theme);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // ─── Load HEAD + working-tree content into the diff models ──────────
  useEffect(() => {
    const ed = diffRef.current;
    if (!ed || !filePath || !projectPath) return;
    let cancelled = false;
    const language = languageFromPath(filePath);
    void Promise.all([
      invoke<string | null>("git_show_head", {
        root: projectPath,
        path: filePath,
      }).catch(() => null),
      // A deleted file has no working-tree content — fall back to empty so
      // the diff still shows the removed lines on the original side.
      invoke<string>("fs_read_file", {
        root: projectPath,
        path: filePath,
      }).catch(() => ""),
    ])
      .then(([head, working]) => {
        if (cancelled) return;
        const prev = ed.getModel();
        const original = monaco.editor.createModel(head ?? "", language);
        const modified = monaco.editor.createModel(working ?? "", language);
        ed.setModel({ original, modified });
        disposeModels(prev);
        setError("");
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, projectPath, refreshKey]);

  return (
    <div className="ae-diff-canvas-wrap" style={{ gridArea: "canvas" }}>
      <div ref={containerRef} className="ae-diff-canvas-host" />
      <div className="ae-editor-status-bar" role="status">
        <span className="ae-editor-status-path" title={filePath}>
          {compressPath(filePath)}
        </span>
        <span className="ae-diff-canvas-badge" aria-label="Diff against HEAD">
          HEAD ↔ Working Tree
        </span>
        <span className="ae-editor-status-spacer" />
        {error && <span className="ae-editor-status-lang">{error}</span>}
        <button
          type="button"
          className="ae-editor-status-action"
          title="Open this file for editing"
          aria-label="Edit file"
          onClick={() => {
            if (tabId) props.onEvent("editor-diff-to-edit", { tabId });
          }}
        >
          Edit file
        </button>
      </div>
    </div>
  );
}
