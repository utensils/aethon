// Mobile-only stand-in for `src/monaco/theme.ts`, redirected at build
// time by vite.mobile.config.ts.
//
// The real module unconditionally does `import { monaco } from "./setup"`,
// and `src/monaco/setup.ts` eagerly imports monaco-editor's five language
// workers (ts/css/html/json/editor, ~7 MB+ unminified) plus
// `@monaco-editor/react`'s loader — none of which the companion app needs,
// since mobile never mounts an editor (editor-canvas/diff-canvas are
// stubbed separately, see desktop-only-canvas.tsx).
//
// `src/runtime/windowApi.ts` is the one remaining real (non-canvas)
// importer of `monaco/theme` — it wires `registerMonacoTheme` /
// `applyMonacoTheme` onto `window.aethon` and calls `applyMonacoTheme` on
// theme changes. Both are safe no-ops here: there is no Monaco instance
// on mobile to register a theme into or apply one onto.
export function registerMonacoTheme(_id: string, _data: unknown): void {
  // no-op — no Monaco instance exists on mobile.
}

export function applyMonacoTheme(_themeId?: string | null): void {
  // no-op — see registerMonacoTheme above.
}
