/**
 * Per-tab Monaco buffer cache.
 *
 * Lives separately from `EditorCanvas` so both the React composite and
 * the `useTabs` lifecycle hook can mutate it without circular imports.
 * Pruning is explicit (tied to the tab-close path) rather than tied to
 * what's in `state.tabs` right now — that way a tab that's hidden by a
 * project bucket swap keeps its unsaved buffer alive until the user
 * actually closes the tab.
 *
 * The cache is intentionally module-level: closing the last editor tab
 * unmounts the React component, but the buffer for a still-open
 * (hidden) tab must survive. Disposal is the only safe place to free
 * the Monaco model.
 */

// Types only — this module is imported by always-loaded tab-lifecycle
// hooks (closeTab, project ops), so a runtime monaco import here would
// drag the whole editor chunk into the boot bundle. The canvas owns the
// runtime import and hands models in via `registerEditorBuffer`.
import type * as monaco from "monaco-editor";

/** An editor tab's in-memory state. The Monaco model is the source of
 *  truth for buffer content + undo stack; viewState carries scroll +
 *  cursor + selection + folds. Both round-trip through tab switches. */
export interface EditorBuffer {
  model: monaco.editor.ITextModel;
  viewState: monaco.editor.ICodeEditorViewState | null;
  /** Set once the initial `fs_read_file` populates the model. The
   *  dirty handler uses `loading` instead — `loaded` is kept for
   *  callers that just want to know "did this buffer ever finish its
   *  first read?" */
  loaded: boolean;
  /** True while the canvas is calling `model.setValue` to populate
   *  the initial disk content. The dirty handler suppresses
   *  `editor-change` events during that window so the bulk replace
   *  doesn't flip the tab dirty. */
  loading: boolean;
  /** Absolute on-disk path the buffer is currently backed by. Kept in
   *  sync with `tab.editor.filePath` so file-tree rename + Cmd+S land
   *  at the new location. */
  filePath: string;
  /** Last-known on-disk mtime (unix ms) for external-change detection.
   *  Stored on the buffer (not the canvas) so the baseline + warning
   *  survive a tab switch that unmounts/remounts the editor canvas.
   *  `undefined` until first captured. */
  externalBaselineMtime?: number;
  /** True when an external on-disk edit was detected under a *dirty*
   *  buffer and the user hasn't reloaded yet — durable across remounts
   *  so the reload affordance isn't lost when switching tabs. */
  externalChanged?: boolean;
}

const EDITOR_BUFFERS = new Map<string, EditorBuffer>();

/** Get the cached buffer for `tabId`, or `undefined` if none yet. */
export function getEditorBuffer(tabId: string): EditorBuffer | undefined {
  return EDITOR_BUFFERS.get(tabId);
}

/** Cache a new buffer around a caller-created model for `tabId`. The
 *  canvas creates the model (it already owns the monaco import). */
export function registerEditorBuffer(
  tabId: string,
  model: monaco.editor.ITextModel,
  filePath: string,
): EditorBuffer {
  const buf: EditorBuffer = {
    model,
    viewState: null,
    loaded: false,
    loading: false,
    filePath,
  };
  EDITOR_BUFFERS.set(tabId, buf);
  return buf;
}

/** Dispose + drop the buffer for `tabId`. Idempotent. Called from
 *  `useTabs.closeTabNow` when the user closes an editor tab. */
export function disposeEditorBuffer(tabId: string): void {
  const buf = EDITOR_BUFFERS.get(tabId);
  if (!buf) return;
  buf.model.dispose();
  EDITOR_BUFFERS.delete(tabId);
}

/** Test-only: dispose every cached buffer. */
export function __resetEditorBuffers(): void {
  for (const buf of EDITOR_BUFFERS.values()) {
    buf.model.dispose();
  }
  EDITOR_BUFFERS.clear();
}
