// Mobile-only stand-in for `src/monaco/editor-buffers.ts`, redirected at
// build time by vite.mobile.config.ts.
//
// The real module does `import * as monaco from "monaco-editor"` just to
// call `monaco.editor.createModel()` / `model.dispose()` — but that bare
// import alone drags in monaco-editor's default language contributions
// (and, transitively, their worker chunks: ts/css/html/json, ~7 MB+),
// which Vite auto-splits into separate async chunks that still ship in
// the IPA even though nothing on mobile ever calls `createEditorBuffer`.
//
// The remaining real importers reachable on mobile — orphanTabSweep,
// tabCleanup, closeTab, useProjectOps, useEditorExternalChange — are
// generic tab-lifecycle hooks that only ever look up or delete from this
// map. `createEditorBuffer` is only ever called from `EditorCanvas`
// itself (src/extensions/default-layout/editor/canvas.tsx), which is
// separately stubbed for mobile (see desktop-only-canvas.tsx) and never
// mounts there, so the map here is always empty in practice. This stub
// mirrors the same bookkeeping without touching Monaco.

interface EditorBuffer {
  model: { dispose(): void };
  viewState: unknown;
  loaded: boolean;
  loading: boolean;
  filePath: string;
  externalBaselineMtime?: number;
  externalChanged?: boolean;
}

const EDITOR_BUFFERS = new Map<string, EditorBuffer>();

export function getEditorBuffer(tabId: string): EditorBuffer | undefined {
  return EDITOR_BUFFERS.get(tabId);
}

export function createEditorBuffer(
  tabId: string,
  filePath: string,
  _language: string,
): EditorBuffer {
  const buf: EditorBuffer = {
    model: {
      dispose() {
        /* no real Monaco model on mobile */
      },
    },
    viewState: null,
    loaded: false,
    loading: false,
    filePath,
  };
  EDITOR_BUFFERS.set(tabId, buf);
  return buf;
}

export function disposeEditorBuffer(tabId: string): void {
  EDITOR_BUFFERS.delete(tabId);
}

export function __resetEditorBuffers(): void {
  EDITOR_BUFFERS.clear();
}
