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

/**
 * Convert a `MouseEvent.clientX` / `clientY` reported by a React pointer
 * handler into a coordinate suitable for `position: fixed` `style.left`
 * / `style.top` on a portal-mounted overlay (context menu, popover).
 *
 * When the html root carries a non-1 `zoom` CSS value, pointer events
 * report coordinates in the zoomed *logical* space (pixels divided by
 * zoom), but `position: fixed` is resolved against the *visual*
 * viewport, so the two diverge at zoom != 1 — a right-click would
 * spawn the menu noticeably offset from the cursor at 125% or 150%
 * zoom. Multiplying the logical coord by the active scale brings them
 * back into alignment.
 *
 * Caller still needs to clamp the result so the menu doesn't fall off
 * the window edge. Pass the menu's outer dims via `clampWidth` /
 * `clampHeight` and the helper computes a clamped pair.
 */
export function clampOverlayPosition(
  clientX: number,
  clientY: number,
  clampWidth: number,
  clampHeight: number,
): { x: number; y: number } {
  const scale = readZoom();
  const x = clientX * scale;
  const y = clientY * scale;
  // visualViewport.width/height are in visual pixels (unzoomed); fall
  // back to inner* when the API isn't available (jsdom).
  const w =
    (typeof window !== "undefined" && window.visualViewport?.width) ||
    (typeof window !== "undefined" && window.innerWidth) ||
    1024;
  const h =
    (typeof window !== "undefined" && window.visualViewport?.height) ||
    (typeof window !== "undefined" && window.innerHeight) ||
    768;
  return {
    x: Math.min(x, Math.max(8, w - clampWidth)),
    y: Math.min(y, Math.max(8, h - clampHeight)),
  };
}
