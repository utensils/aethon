// Sets the CSS viewport vars and the document `zoom` so the layout's
// scale stays consistent when DPI/zoom changes. App-wide UI scale is
// driven by the `--app-ui-scale` custom property; viewport-derived
// helpers (sticky scroll, sidebar widths) read the var rather than
// `window.inner*` so they match the rendered layout.

const MAX_REASONABLE_VIEWPORT_PX = 100_000;

function saneViewportSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value < MAX_REASONABLE_VIEWPORT_PX
  );
}

function viewportSize(axis: "width" | "height"): number {
  const visual = window.visualViewport?.[axis];
  const inner = axis === "width" ? window.innerWidth : window.innerHeight;
  const outer = axis === "width" ? window.outerWidth : window.outerHeight;
  const docClient =
    axis === "width"
      ? document.documentElement.clientWidth
      : document.documentElement.clientHeight;
  const bodyClient =
    axis === "width" ? document.body?.clientWidth : document.body?.clientHeight;
  const screenAvail =
    axis === "width" ? window.screen?.availWidth : window.screen?.availHeight;
  const screenSize =
    axis === "width" ? window.screen?.width : window.screen?.height;

  for (const value of [
    visual,
    inner,
    outer,
    docClient,
    bodyClient,
    screenAvail,
    screenSize,
  ]) {
    if (saneViewportSize(value)) return value;
  }

  return axis === "width" ? 1024 : 768;
}

export function writeUiViewportVars(scale: number) {
  const root = document.documentElement;
  const safeScale = saneViewportSize(scale) ? scale : 1;
  root.style.setProperty(
    "--app-viewport-width",
    `${viewportSize("width") / safeScale}px`,
  );
  root.style.setProperty(
    "--app-viewport-height",
    `${viewportSize("height") / safeScale}px`,
  );
}

export function applyUiScale(scale: number) {
  const previous = readZoom();
  const root = document.documentElement;
  root.style.setProperty("--app-ui-scale", String(scale));
  writeUiViewportVars(scale);
  root.style.zoom = String(scale);
  if (Math.abs(scale - previous) >= 0.0001) {
    window.dispatchEvent(
      new CustomEvent("aethon:ui-scale-change", { detail: { scale } }),
    );
  }
}

export function readZoom(): number {
  const cur = parseFloat(
    document.documentElement.style.getPropertyValue("--app-ui-scale") ||
      document.documentElement.style.zoom ||
      "1",
  );
  return Number.isFinite(cur) ? cur : 1;
}
