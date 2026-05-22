/**
 * EditorCanvas — Monaco-backed editor surface for editor tabs.
 *
 * Architecture: one Monaco editor instance mounted while any editor tab
 * is visible; we swap `setModel` (one model per tabId) on tab switches
 * so scroll position, cursor, undo stack, selection, and unsaved
 * buffer all survive tab switches. Mirrors VSCode's model-per-file
 * approach.
 *
 * Buffers live in a module-level `Map<tabId, EditorBuffer>` so they
 * survive the React component unmount that happens when no editor tab
 * is active (e.g. user switches to an agent tab). The next time the
 * component remounts and the tab becomes active again, its model and
 * saved viewState are still there and we just `setModel` + restore.
 *
 * Orphaned buffers (whose tab id no longer appears in `state.tabs`)
 * are pruned in a `tabs`-watcher effect — that catches the user
 * closing a tab via the X button, Cmd+W, or close-all.
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

interface EditorBuffer {
  /** Monaco model holding the file's text. Disposed only when the
   *  matching editor tab is closed. */
  model: monaco.editor.ITextModel;
  /** Persisted view state (scroll, cursor, selection, folds, etc.).
   *  Saved on tab switch + window blur; restored on re-entry. */
  viewState: monaco.editor.ICodeEditorViewState | null;
  /** Set once `fs_read_file` has populated the model. Subsequent
   *  visits to the tab reuse the in-memory buffer rather than re-read
   *  the file (so unsaved edits survive). */
  loaded: boolean;
  /** Absolute path the buffer is backed by. Tracks renames. */
  filePath: string;
}

/** Module-level buffer cache. Lives across React mount/unmount cycles
 *  so closing the last editor tab + reopening doesn't lose work. */
const EDITOR_BUFFERS = new Map<string, EditorBuffer>();

/** Dispose buffers for tab ids that no longer exist. Called from the
 *  tabs-watcher effect so closed tabs don't leak Monaco models.
 *  Exported for test cleanup. */
export function pruneEditorBuffers(liveTabIds: Iterable<string>): void {
  const live = new Set(liveTabIds);
  for (const [id, buf] of EDITOR_BUFFERS) {
    if (!live.has(id)) {
      buf.model.dispose();
      EDITOR_BUFFERS.delete(id);
    }
  }
}

/** Update an editor buffer's file path after a rename. The Monaco
 *  model itself doesn't carry the path; we only need to keep the
 *  buffer cache's `filePath` in sync so the next Cmd+S writes to the
 *  new location. Exported for the file-tree rename flow. */
export function renameEditorBuffer(tabId: string, newPath: string): void {
  const buf = EDITOR_BUFFERS.get(tabId);
  if (!buf) return;
  buf.filePath = newPath;
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
  // Current tab the editor is bound to. Used by the (single) set of
  // event listeners to forward events with the right tab id.
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
    // Kick off the Shiki bridge in the background — when it resolves
    // Monaco re-tokenises any live models with the new grammars + the
    // active theme (now resolved to github-dark/github-light).
    void ensureShikiMonacoReady()
      .then(() => {
        applyMonacoTheme(document.documentElement.dataset.theme);
      })
      .catch(() => {
        // Fall through to Monaco's built-in tokenisation — better than
        // throwing.
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

    // Mark dirty on content changes — but only after the model's
    // initial setValue from fs_read_file has completed. We track that
    // via the buffer's `loaded` flag.
    const contentDisposable = ed.onDidChangeModelContent(() => {
      const tid = currentTabIdRef.current;
      if (!tid) return;
      const buf = EDITOR_BUFFERS.get(tid);
      if (!buf?.loaded) return;
      onEvent("editor-change", { tabId: tid, isDirty: true });
    });

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const tid = currentTabIdRef.current;
      if (!tid) return;
      const buf = EDITOR_BUFFERS.get(tid);
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
        const buf = EDITOR_BUFFERS.get(tid);
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
      const prevBuf = EDITOR_BUFFERS.get(prev);
      if (prevBuf) prevBuf.viewState = ed.saveViewState();
    }
    currentTabIdRef.current = tabId;
    setLoadError("");

    let buf = EDITOR_BUFFERS.get(tabId);
    const language = editorMeta.language || "plaintext";
    if (!buf) {
      const model = monaco.editor.createModel("", language);
      buf = {
        model,
        viewState: null,
        loaded: false,
        filePath: editorMeta.filePath,
      };
      EDITOR_BUFFERS.set(tabId, buf);
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
          // The user may have switched away before the read landed —
          // still populate the buffer so a later tab-switch back finds
          // it ready, but only touch the editor view if it's still
          // bound to this tab.
          initialBuf.model.setValue(text);
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

  // ─── Prune buffers for tabs that have been closed ──────────────────
  useEffect(() => {
    const editorIds = tabs.filter((t) => t.kind === "editor").map((t) => t.id);
    pruneEditorBuffers(editorIds);
  }, [tabs]);

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
