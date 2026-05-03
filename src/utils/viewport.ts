// Sets the CSS viewport vars and the document `zoom` so the layout's
// scale stays consistent when DPI/zoom changes. App-wide UI scale is
// driven by the `--app-ui-scale` custom property; viewport-derived
// helpers (sticky scroll, sidebar widths) read the var rather than
// `window.inner*` so they match the rendered layout.

export function writeUiViewportVars(scale: number) {
  const root = document.documentElement;
  root.style.setProperty("--app-viewport-width", `${window.innerWidth / scale}px`);
  root.style.setProperty("--app-viewport-height", `${window.innerHeight / scale}px`);
}

export function applyUiScale(scale: number) {
  const root = document.documentElement;
  root.style.setProperty("--app-ui-scale", String(scale));
  writeUiViewportVars(scale);
  root.style.zoom = String(scale);
}

export function readZoom(): number {
  const cur = parseFloat(
    document.documentElement.style.getPropertyValue("--app-ui-scale") ||
      document.documentElement.style.zoom ||
      "1",
  );
  return Number.isFinite(cur) ? cur : 1;
}
