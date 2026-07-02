// Build-time stand-in for the desktop editor surfaces. The mobile layout
// (mobile.a2ui.json) never places `editor-canvas` or `diff-canvas` — the
// companion app has no code editor — but the default-layout extension
// (src/extensions/default-layout/components.tsx) statically imports both,
// which pulls in all of monaco-editor plus five language workers
// (~7 MB+) into the mobile bundle even though they're unreachable at
// runtime.
//
// vite.mobile.config.ts redirects the resolved paths of
// `editor/canvas.tsx` and `editor/diff-canvas.tsx` to this module for the
// mobile build only (dev server + `build:mobile`); the desktop build
// (vite.config.ts) is untouched and still ships the real Monaco-backed
// components. Export names must match what those two modules export —
// `EditorCanvas` and `DiffCanvas` — so `editor/index.ts`'s re-exports
// keep resolving.

import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

function DesktopOnlyCanvas(_props: BuiltinComponentProps) {
  return (
    <div className="ae-mobile-desktop-only" style={{ gridArea: "canvas" }} role="status">
      <p className="ae-mobile-desktop-only-message">Open this file on the desktop.</p>
      <p className="ae-mobile-desktop-only-hint">
        The code editor isn't available in the iOS companion.
      </p>
    </div>
  );
}

export { DesktopOnlyCanvas as EditorCanvas, DesktopOnlyCanvas as DiffCanvas };
