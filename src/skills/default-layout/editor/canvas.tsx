/**
 * EditorCanvas — Monaco-backed editor surface for editor tabs.
 *
 * Architecture: one Monaco editor instance mounted while any editor tab
 * is visible; we swap `setModel` (one model per tabId) on tab switches
 * so scroll position, cursor, undo stack, selection, and unsaved
 * buffer all survive tab switches. Mirrors VSCode's model-per-file
 * approach.
 *
 * Buffers live in `src/monaco/editor-buffers.ts` so they survive the
 * React component unmount that happens when no editor tab is active
 * (e.g. user switches to an agent tab or to a project whose visible
 * bucket has no editor tabs). The next time the component remounts and
 * the tab becomes active again, its model and saved viewState are
 * still there and we just `setModel` + restore.
 *
 * Buffers are disposed explicitly when the user closes a tab —
 * `useTabs.closeTabNow` calls `disposeEditorBuffer(tabId)`. We
 * intentionally don't prune from this component based on
 * `state.tabs` because a project-bucket swap removes tabs from the
 * visible list while still keeping them in `tabBucketsRef`; disposing
 * those would drop unsaved edits when the user comes back to the
 * other project.
 *
 * Shiki ↔ Monaco grammars/themes are wired by `ensureShikiMonacoReady()`
 * the first time the canvas mounts. Until that resolves the editor
 * paints with Monaco's built-in tokenisation; once Shiki binds, models
 * re-tokenise in place.
 */

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";

import type { StringValue } from "../../../types/a2ui";
import { resolveString } from "../../../utils/dataBinding";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { applyMonacoTheme } from "../../../monaco/theme";
import { ensureShikiMonacoReady } from "../../../monaco/shiki";
import {
  createEditorBuffer,
  getEditorBuffer,
} from "../../../monaco/editor-buffers";

interface EditorTabLike {
  id: string;
  kind?: string;
  editor?: {
    filePath?: string;
    language?: string;
    isDirty?: boolean;
    cursorLine?: number;
    cursorColumn?: number;
  };
}

export function EditorCanvas({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    tabId?: StringValue;
  };
  const tabId = props.tabId ? resolveString(props.tabId, state) : "";

  const tabs = (state["tabs"] as EditorTabLike[] | undefined) ?? [];
  const boundTab = tabs.find((t) => t.id === tabId);
  const editorMeta = boundTab?.editor;
  const project = state["project"] as { path?: string } | undefined;
  const projectPath = project?.path ?? "";

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const currentTabIdRef = useRef<string>("");
  const projectPathRef = useRef<string>(projectPath);
  const [loadError, setLoadError] = useState<string>("");
  const [cursorDisplay, setCursorDisplay] = useState<{ line: number; column: number }>({
    line: 1,
    column: 1,
  });

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  // ─── Mount one editor instance for the lifetime of this canvas ──────
  useEffect(() => {
    if (!containerRef.current) return;
    applyMonacoTheme(document.documentElement.dataset.theme);
    void ensureShikiMonacoReady()
      .then(() => {
        applyMonacoTheme(document.documentElement.dataset.theme);
      })
      .catch(() => {
        /* fall through to Monaco's built-in tokenisation */
      });

    const ed = monaco.editor.create(containerRef.current, {
      automaticLayout: true,
      contextmenu: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      wordWrap: "off",
    });
    editorRef.current = ed;

    const positionDisposable = ed.onDidChangeCursorPosition((e) => {
      setCursorDisplay({ line: e.position.lineNumber, column: e.position.column });
      const tid = currentTabIdRef.current;
      if (!tid) return;
      onEvent("editor-cursor", {
        tabId: tid,
        line: e.position.lineNumber,
        column: e.position.column,
      });
    });

    // Mark dirty on content changes. We suppress the event while
    // `buf.loading` is true — that's the window where the canvas is
    // calling `model.setValue` to populate disk content, and we don't
    // want that bulk replace to flip the tab dirty. User keystrokes
    // arriving *before* the load lands fall through (buffer is still
    // populated by setValue afterwards only when no user content exists
    // — see the load callback below).
    const contentDisposable = ed.onDidChangeModelContent(() => {
      const tid = currentTabIdRef.current;
      if (!tid) return;
      const buf = getEditorBuffer(tid);
      if (!buf) return;
      if (buf.loading) return;
      onEvent("editor-change", { tabId: tid, isDirty: true });
    });

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const tid = currentTabIdRef.current;
      if (!tid) return;
      const buf = getEditorBuffer(tid);
      if (!buf) return;
      onEvent("editor-save", {
        tabId: tid,
        filePath: buf.filePath,
        content: buf.model.getValue(),
      });
    });

    return () => {
      // Save the active tab's view state before unmount so it survives
      // the canvas going away (e.g. user switched to a non-editor tab).
      const tid = currentTabIdRef.current;
      if (tid) {
        const buf = getEditorBuffer(tid);
        if (buf) buf.viewState = ed.saveViewState();
      }
      positionDisposable.dispose();
      contentDisposable.dispose();
      ed.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Swap models when the active editor tab changes ────────────────
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!tabId) return;
    if (!editorMeta?.filePath) return;

    // Save the outgoing tab's view state before swap.
    const prev = currentTabIdRef.current;
    if (prev && prev !== tabId) {
      const prevBuf = getEditorBuffer(prev);
      if (prevBuf) prevBuf.viewState = ed.saveViewState();
    }
    currentTabIdRef.current = tabId;
    setLoadError("");

    const language = editorMeta.language || "plaintext";
    let buf = getEditorBuffer(tabId);
    if (!buf) {
      buf = createEditorBuffer(tabId, editorMeta.filePath, language);
    } else if (buf.filePath !== editorMeta.filePath) {
      // Tab was renamed (file-tree rename or folder-rename prefix
      // rewrite). Sync the cache so the next Cmd+S writes to the new
      // path. The model itself doesn't need to be recreated — only
      // its on-disk anchor.
      buf.filePath = editorMeta.filePath;
    }

    ed.setModel(buf.model);
    if (buf.viewState) ed.restoreViewState(buf.viewState);
    ed.focus();

    // Lazy file read. Skipped if the buffer is already populated (the
    // user came back to this tab after editing). This is what makes
    // scroll/cursor/dirty all survive tab switches.
    if (!buf.loaded) {
      const root = projectPathRef.current;
      const path = editorMeta.filePath;
      const initialBuf = buf;
      void invoke<string>("fs_read_file", { root, path })
        .then((text) => {
          // If the user typed before the read landed, keep their
          // content — overwriting it now would silently destroy edits.
          // We do still mark the buffer "loaded" so subsequent
          // keystrokes can no-op the load path; the dirty flag stays
          // (or starts) true because the content-change listener
          // already fired (or will fire) for the user's typing.
          const hadUserEdits = initialBuf.model.getValueLength() > 0;
          if (hadUserEdits) {
            initialBuf.loaded = true;
            // Ensure dirty is set — the listener may have skipped
            // earlier events if loading was somehow toggled.
            onEvent("editor-change", {
              tabId,
              isDirty: true,
            });
            return;
          }
          // Wrap setValue in the loading window so the bulk-replace
          // doesn't flip the tab dirty via the content listener.
          initialBuf.loading = true;
          initialBuf.model.setValue(text);
          initialBuf.loading = false;
          initialBuf.loaded = true;
          if (currentTabIdRef.current === tabId) {
            if (editorMeta.cursorLine && editorMeta.cursorColumn) {
              try {
                const pos = {
                  lineNumber: editorMeta.cursorLine,
                  column: editorMeta.cursorColumn,
                };
                ed.setPosition(pos);
                ed.revealPositionInCenter(pos);
              } catch {
                /* ignore invalid persisted cursor */
              }
            }
          }
          onEvent("editor-loaded", { tabId, filePath: path });
        })
        .catch((err: unknown) => {
          if (currentTabIdRef.current === tabId) {
            setLoadError(String(err));
          }
        });
    }
  }, [tabId, editorMeta?.filePath, editorMeta?.language, onEvent, editorMeta?.cursorLine, editorMeta?.cursorColumn]);

  // ─── React to theme changes after mount ────────────────────────────
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => applyMonacoTheme(root.dataset.theme);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="ae-editor-canvas-wrap" style={{ gridArea: "canvas" }}>
      <div ref={containerRef} className="ae-editor-canvas-host" />
      {loadError && (
        <div className="ae-editor-canvas-error">Failed to load file: {loadError}</div>
      )}
      <EditorStatusBar
        filePath={editorMeta?.filePath ?? ""}
        language={editorMeta?.language ?? "plaintext"}
        isDirty={Boolean(editorMeta?.isDirty)}
        line={cursorDisplay.line}
        column={cursorDisplay.column}
      />
    </div>
  );
}

interface EditorStatusBarProps {
  filePath: string;
  language: string;
  isDirty: boolean;
  line: number;
  column: number;
}

function EditorStatusBar({
  filePath,
  language,
  isDirty,
  line,
  column,
}: EditorStatusBarProps) {
  const shortPath = compressPath(filePath);
  return (
    <div className="ae-editor-status-bar" role="status">
      <span className="ae-editor-status-path" title={filePath}>
        {shortPath}
      </span>
      {isDirty && (
        <span className="ae-editor-status-dirty" title="Unsaved changes" aria-label="Unsaved changes">
          •
        </span>
      )}
      <span className="ae-editor-status-spacer" />
      <span className="ae-editor-status-pos">
        Ln {line}, Col {column}
      </span>
      <span className="ae-editor-status-sep" aria-hidden="true">·</span>
      <span className="ae-editor-status-lang">{language}</span>
    </div>
  );
}

/** Show the last 2 path components — full path is in the title attribute. */
function compressPath(filePath: string): string {
  if (!filePath) return "";
  const parts = filePath.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return filePath;
  return `…/${parts.slice(-2).join("/")}`;
}
