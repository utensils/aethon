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

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as monaco from "monaco-editor";

import type { StringValue } from "../../../types/a2ui";
import { resolveString } from "../../../utils/dataBinding";
import {
  RegistryComponent,
  type BuiltinComponentProps,
} from "../../../components/A2UIRenderer";
import { applyMonacoTheme } from "../../../monaco/theme";
import { ensureShikiMonacoReady } from "../../../monaco/shiki";
import {
  createEditorBuffer,
  getEditorBuffer,
} from "../../../monaco/editor-buffers";
import { pickFileViewer } from "./file-viewers";
import { compressPath } from "./path";
import { hunksToGutterDecorations, type DiffHunk } from "./git-gutter";
import { EditorMenubar } from "./menubar";
import { createEditorActions, type EditorActions } from "./editorActions";
import { useEditorViewSettings } from "./useEditorViewSettings";
import { useEditorExternalChange } from "./useEditorExternalChange";
import { monacoOptionsFor } from "./viewSettings";
import { handleEditorLinkOpen } from "./link-openers";

/** Read the shared `--scrollbar-size` token (px) so Monaco's scrollbar
 *  matches the terminal + WebKit scrollbars. Falls back to 4px. */
function scrollbarSizePx(): number {
  if (typeof getComputedStyle !== "function") return 4;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--scrollbar-size")
    .trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

interface EditorTabLike {
  id: string;
  kind?: string;
  editor?: {
    filePath?: string;
    rootPath?: string;
    language?: string;
    isDirty?: boolean;
    cursorLine?: number;
    cursorColumn?: number;
    /** When true, render the markdown preview instead of Monaco for
     *  this tab. Toggled by Cmd+Shift+V. Has no effect on non-markdown
     *  files (the canvas only branches when language === "markdown"). */
    previewMode?: boolean;
    /** Bumps on every successful save so the preview re-reads. */
    previewRefreshKey?: number;
    /** When true, render the read-only side-by-side diff (HEAD vs working
     *  tree) instead of the editable Monaco editor. */
    diff?: boolean;
  };
}

export function EditorCanvas({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    tabId?: StringValue;
  };
  const tabId = props.tabId ? resolveString(props.tabId, state) : "";

  const tabs = (state["tabs"] as EditorTabLike[] | undefined) ?? [];
  const boundTab = tabs.find((t) => t.id === tabId);
  const editorMeta = boundTab?.editor;
  const project = state["project"] as { path?: string } | undefined;
  const projectPath = editorMeta?.rootPath ?? project?.path ?? "";
  // Cheap primitive that changes when the working tree shifts under us
  // (branch switch, discard, external edit) so the gutter re-polls
  // without depending on the whole `state` object (which would re-run on
  // every keystroke).
  const vcs = state["vcs"] as
    | {
        branch?: string;
        changes?: { total?: number; additions?: number; deletions?: number };
      }
    | undefined;
  const vcsSignal = `${vcs?.branch ?? ""}:${vcs?.changes?.total ?? 0}`;

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const gutterRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(
    null,
  );
  const currentTabIdRef = useRef<string>("");
  const projectPathRef = useRef<string>(projectPath);
  // Stable reference to the live onEvent callback. The renderer
  // recreates the callback on every render; routing through a ref
  // keeps the model-swap effect's identity stable so it doesn't re-run
  // (and re-call `restoreViewState`) on every keystroke that ripples
  // back into state.
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);
  // Whether the active tab is a (read-only) diff view — guards the native
  // menu Save/Revert listeners from writing the hidden editable buffer.
  // Synced in an effect declared *before* the mount effect that reads it,
  // so the ref is written before it's used downstream.
  const isDiffRef = useRef(false);
  useEffect(() => {
    isDiffRef.current = editorMeta?.diff === true;
  }, [editorMeta?.diff]);
  const [loadError, setLoadError] = useState<string>("");
  const [cursorDisplay, setCursorDisplay] = useState<{
    line: number;
    column: number;
  }>({
    line: 1,
    column: 1,
  });

  // Persisted View-menu settings (word wrap / minimap / line numbers / zoom).
  // viewSettingsRef seeds the one-time create() options; live changes flow
  // through the updateOptions effect below, so the ref needs no resync.
  const view = useEditorViewSettings();
  const viewSettingsRef = useRef(view.settings);

  const isDirty = Boolean(editorMeta?.isDirty);
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  // Reload the active buffer from disk — shared by the menu Revert action
  // and external-change auto-reload. Skips only the setValue when the
  // content is byte-identical (so our own saves don't churn the undo
  // stack), but ALWAYS emits editor-loaded so Revert clears a dirty flag
  // even when the buffer already matches disk (edit-then-undo case).
  const reloadActiveBuffer = useCallback(() => {
    const tid = currentTabIdRef.current;
    if (!tid || isDiffRef.current) return;
    const buf = getEditorBuffer(tid);
    if (!buf) return;
    const root = projectPathRef.current;
    if (!root) return;
    void invoke<string>("fs_read_file", { root, path: buf.filePath })
      .then((text) => {
        if (buf.model.getValue() !== text) {
          buf.loading = true;
          buf.model.setValue(text);
          buf.loading = false;
        }
        buf.loaded = true;
        onEventRef.current("editor-loaded", {
          tabId: tid,
          filePath: buf.filePath,
        });
      })
      .catch(() => {
        /* file vanished or unreadable — leave the buffer as-is */
      });
  }, []);

  // Imperative editor operations for the menubar (Edit / View / Go +
  // reveal / close). Created once in the mount effect (where ref access
  // is allowed) and held in state so its closures bind the stable refs.
  const [actions, setActions] = useState<EditorActions | null>(null);

  const { externalChanged, captureBaseline, reloadExternal } =
    useEditorExternalChange({
      tabId,
      filePath: editorMeta?.filePath ?? "",
      root: projectPath,
      isDirtyRef,
      reload: reloadActiveBuffer,
    });

  // Re-baseline the external-change watcher whenever the buffer returns to
  // a clean state (our own save / load), so a self-write never trips it.
  useEffect(() => {
    if (!isDirty) captureBaseline();
  }, [isDirty, captureBaseline]);

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
      scrollBeyondLastLine: false,
      tabSize: 2,
      // Match the terminal + WebKit scrollbar width for a consistent UI.
      scrollbar: {
        verticalScrollbarSize: scrollbarSizePx(),
        horizontalScrollbarSize: scrollbarSizePx(),
      },
      // Seed word wrap / minimap / line numbers / font size from the
      // persisted View settings so there's no default-then-snap flash.
      ...monacoOptionsFor(viewSettingsRef.current),
    });
    editorRef.current = ed;

    const linkOpenerDisposable = monaco.editor.registerLinkOpener({
      open: (resource) =>
        handleEditorLinkOpen(resource, {
          currentTabId: currentTabIdRef.current,
          projectPath: projectPathRef.current,
          openExternalUrl: openUrl,
          openMarkdownFile: ({ tabId, filePath, rootPath }) => {
            onEventRef.current("markdown-link-open", {
              tabId,
              filePath,
              rootPath,
            });
          },
        }),
    });

    // Build the menubar actions now that the editor exists. The closures
    // bind the stable refs, so this object stays valid across tab swaps.
    setActions(
      createEditorActions({
        getEditor: () => editorRef.current,
        getFilePath: () =>
          getEditorBuffer(currentTabIdRef.current)?.filePath ?? "",
        getRoot: () => projectPathRef.current,
        getTabId: () => currentTabIdRef.current,
        invoke,
        closeTab: (id) => onEventRef.current("editor-close", { tabId: id }),
      }),
    );

    const positionDisposable = ed.onDidChangeCursorPosition((e) => {
      setCursorDisplay({
        line: e.position.lineNumber,
        column: e.position.column,
      });
      const tid = currentTabIdRef.current;
      if (!tid) return;
      onEventRef.current("editor-cursor", {
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
      onEventRef.current("editor-change", { tabId: tid, isDirty: true });
    });

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const tid = currentTabIdRef.current;
      if (!tid) return;
      const buf = getEditorBuffer(tid);
      if (!buf) return;
      onEventRef.current("editor-save", {
        tabId: tid,
        filePath: buf.filePath,
        content: buf.model.getValue(),
      });
    });

    // Native File-menu Save / Revert (Cmd+S routes to the menu on macOS,
    // not the addCommand above) and the toolbar fall through to these.
    const onMenuSave = () => {
      const tid = currentTabIdRef.current;
      if (!tid || isDiffRef.current) return;
      const buf = getEditorBuffer(tid);
      if (!buf) return;
      onEventRef.current("editor-save", {
        tabId: tid,
        filePath: buf.filePath,
        content: buf.model.getValue(),
      });
    };
    const onMenuRevert = () => reloadActiveBuffer();
    window.addEventListener("aethon:editor-save", onMenuSave);
    window.addEventListener("aethon:editor-revert", onMenuRevert);

    return () => {
      window.removeEventListener("aethon:editor-save", onMenuSave);
      window.removeEventListener("aethon:editor-revert", onMenuRevert);
      // Save the active tab's view state before unmount so it survives
      // the canvas going away (e.g. user switched to a non-editor tab).
      const tid = currentTabIdRef.current;
      if (tid) {
        const buf = getEditorBuffer(tid);
        if (buf) buf.viewState = ed.saveViewState();
      }
      linkOpenerDisposable.dispose();
      positionDisposable.dispose();
      contentDisposable.dispose();
      ed.dispose();
      editorRef.current = null;
    };
  }, [reloadActiveBuffer]);

  // Initial cursor for a NEW (just-loaded) buffer comes from the
  // persisted editor meta. We capture it via a ref to avoid putting
  // cursorLine/cursorColumn in the model-swap effect's deps — that
  // would re-run the effect on every keystroke that ripples back into
  // state via `editor-cursor`, snapping the view to the persisted
  // position mid-typing.
  const initialCursorRef = useRef<{ line?: number; column?: number }>({});
  useEffect(() => {
    initialCursorRef.current = {
      line: editorMeta?.cursorLine,
      column: editorMeta?.cursorColumn,
    };
  }, [editorMeta?.cursorLine, editorMeta?.cursorColumn]);

  // ─── Swap models when the active editor tab changes ────────────────
  // Deps are narrow on purpose: only tabId / filePath / language flip
  // the model. Live cursor updates and project-path readiness are
  // handled by the separate load effect below.
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
    // Clear any stale error from a previous tab's failed load — the
    // user has actively switched, so the prior error message is no
    // longer relevant. Synchronous setState in an effect is the
    // simplest way to reset state-resync of this kind.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  }, [tabId, editorMeta?.filePath, editorMeta?.language]);

  // ─── Load file content for unloaded buffers ────────────────────────
  // Depends on projectPath so a restored editor tab whose project list
  // hasn't loaded yet retries the read once `state.project.path`
  // arrives, instead of being permanently stuck on the
  // "non-absolute root" error.
  useEffect(() => {
    if (!tabId) return;
    if (!editorMeta?.filePath) return;
    if (!projectPath) return;
    const ed = editorRef.current;
    if (!ed) return;
    const buf = getEditorBuffer(tabId);
    if (!buf || buf.loaded) return;

    const path = editorMeta.filePath;
    const initialBuf = buf;
    void invoke<string>("fs_read_file", { root: projectPath, path })
      .then((text) => {
        // If the user typed before the read landed, keep their
        // content — overwriting it now would silently destroy edits.
        const hadUserEdits = initialBuf.model.getValueLength() > 0;
        if (hadUserEdits) {
          initialBuf.loaded = true;
          onEventRef.current("editor-change", {
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
          const { line, column } = initialCursorRef.current;
          if (line && column) {
            try {
              const pos = { lineNumber: line, column };
              ed.setPosition(pos);
              ed.revealPositionInCenter(pos);
            } catch {
              /* ignore invalid persisted cursor */
            }
          }
        }
        onEventRef.current("editor-loaded", { tabId, filePath: path });
      })
      .catch((err: unknown) => {
        if (currentTabIdRef.current === tabId) {
          setLoadError(String(err));
        }
      });
  }, [tabId, editorMeta?.filePath, projectPath]);

  // ─── Apply View-menu settings to the live editor ───────────────────
  // updateOptions is editor-wide (survives setModel), so applying on
  // settings change is enough; the create() call seeds the initial pass.
  useEffect(() => {
    editorRef.current?.updateOptions(monacoOptionsFor(view.settings));
  }, [view.settings]);

  // ─── React to theme changes after mount ────────────────────────────
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => applyMonacoTheme(root.dataset.theme);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // Branch on file viewer registry first — image / pdf / future custom
  // viewers overlay Monaco for matching extensions. The Monaco host div
  // stays mounted (display: none below) so the mount effect's
  // containerRef populates on first render even when the active tab is
  // an image; switching to a text file later then "just works" without
  // recreating Monaco.
  const filePath = editorMeta?.filePath ?? "";
  const viewerType = pickFileViewer(filePath);
  const previewMode =
    editorMeta?.previewMode === true && editorMeta?.language === "markdown";
  // A diff tab takes precedence over every other surface — it's an
  // explicit "show me the changes" request.
  const showDiff = editorMeta?.diff === true;
  const showViewer = !!viewerType && !showDiff;
  const showPreview = previewMode && !showViewer && !showDiff;
  const showMonaco = !showDiff && !showViewer && !showPreview;

  // Re-measure the editor when the host transitions from display:none
  // back to visible. automaticLayout's ResizeObserver fires on the size
  // change too, but the explicit call avoids a one-frame "0x0" paint
  // when toggling preview off in a tab that's been hidden for a while.
  useEffect(() => {
    if (!showMonaco) return;
    const ed = editorRef.current;
    if (!ed) return;
    const raf = requestAnimationFrame(() => ed.layout());
    return () => cancelAnimationFrame(raf);
  }, [showMonaco]);

  // ─── Git gutter (dirty-diff) indicators ────────────────────────────
  // VS Code-style added/modified/deleted bars in the line gutter, polled
  // from `git_file_diff_hunks` (working tree vs HEAD). Refreshes on tab
  // swap, save (isDirty flip), and external working-tree changes
  // (vcsSignal). Cleared for non-text surfaces (image/preview viewers).
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const collection =
      gutterRef.current ??
      (gutterRef.current = ed.createDecorationsCollection());
    if (!showMonaco || !tabId || !editorMeta?.filePath || !projectPath) {
      collection.clear();
      return;
    }
    const path = editorMeta.filePath;
    const root = projectPath;
    const forTabId = tabId;
    let cancelled = false;
    void invoke<DiffHunk[] | null>("git_file_diff_hunks", { root, path })
      .then((hunks) => {
        if (cancelled || currentTabIdRef.current !== forTabId) return;
        const model = ed.getModel();
        const lineCount = model ? model.getLineCount() : 0;
        const decorations = hunksToGutterDecorations(hunks, lineCount).map(
          (d) => ({
            range: new monaco.Range(d.startLine, 1, d.endLine, 1),
            options: {
              isWholeLine: false,
              linesDecorationsClassName: d.className,
            },
          }),
        );
        collection.set(decorations);
      })
      .catch(() => {
        if (!cancelled) collection.clear();
      });
    return () => {
      cancelled = true;
    };
  }, [
    tabId,
    editorMeta?.filePath,
    editorMeta?.isDirty,
    projectPath,
    showMonaco,
    vcsSignal,
  ]);

  return (
    <div className="ae-editor-canvas-wrap" style={{ gridArea: "canvas" }}>
      {(showMonaco || showPreview) && actions && (
        <EditorMenubar
          isDirty={isDirty}
          canMutate={showMonaco}
          canPreview={editorMeta?.language === "markdown"}
          previewActive={showPreview}
          externalChanged={externalChanged}
          onTogglePreview={
            tabId
              ? () => onEventRef.current("editor-preview-toggle", { tabId })
              : undefined
          }
          onReloadExternal={reloadExternal}
          actions={actions}
          view={view}
        />
      )}
      <div
        ref={containerRef}
        className="ae-editor-canvas-host"
        style={showMonaco ? undefined : { display: "none" }}
      />
      {viewerType && (
        <RegistryComponent
          type={viewerType}
          state={state}
          onEvent={(_c, eventType, data) => {
            onEvent(eventType, data);
          }}
          componentProps={{ filePath, projectPath }}
        />
      )}
      {showPreview && (
        <RegistryComponent
          type="markdown-preview"
          state={state}
          onEvent={(_c, eventType, data) => {
            onEvent(eventType, data);
          }}
          componentProps={{
            filePath,
            projectPath,
            tabId,
            refreshKey: editorMeta?.previewRefreshKey ?? 0,
          }}
        />
      )}
      {showDiff && (
        <RegistryComponent
          type="diff-canvas"
          state={state}
          onEvent={(_c, eventType, data) => {
            onEvent(eventType, data);
          }}
          componentProps={{
            filePath,
            projectPath,
            tabId,
            // Re-read the diff when the working tree shifts (save, discard,
            // branch switch). Key on the diff stat (additions/deletions),
            // not just the changed-file count — editing the same already-
            // modified file and saving leaves `total` unchanged but moves
            // the +/- counts, and a count-only key would leave the diff
            // stale.
            refreshKey: `${vcs?.changes?.total ?? 0}:${
              vcs?.changes?.additions ?? 0
            }:${vcs?.changes?.deletions ?? 0}`,
          }}
        />
      )}
      {showMonaco && loadError && (
        <div className="ae-editor-canvas-error">
          Failed to load file: {loadError}
        </div>
      )}
      {showMonaco && (
        <EditorStatusBar
          filePath={editorMeta?.filePath ?? ""}
          language={editorMeta?.language ?? "plaintext"}
          isDirty={Boolean(editorMeta?.isDirty)}
          line={cursorDisplay.line}
          column={cursorDisplay.column}
        />
      )}
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
        <span
          className="ae-editor-status-dirty"
          title="Unsaved changes"
          aria-label="Unsaved changes"
        >
          •
        </span>
      )}
      <span className="ae-editor-status-spacer" />
      <span className="ae-editor-status-pos">
        Ln {line}, Col {column}
      </span>
      <span className="ae-editor-status-sep" aria-hidden="true">
        ·
      </span>
      <span className="ae-editor-status-lang">{language}</span>
    </div>
  );
}
