/**
 * Determine which coordinate frame the current engine reports pointer
 * coords + `getBoundingClientRect` in, under html-level CSS `zoom`.
 *
 * CSS `zoom` is non-standard, and engines disagree:
 *
 *   - WebKit (WKWebView, Safari, WebKitGTK): event coords + rects live
 *     in **visual** pixels (post-zoom multiplication), while CSS
 *     `position: fixed; left/top` are interpreted in **layout** pixels.
 *     The two frames diverge at zoom != 1; placing a fixed element at
 *     `clientX` lands it past the cursor.
 *   - Chromium (WebView2, Edge): event coords, rects, and CSS used
 *     values all live in the layout frame. No compensation needed.
 *
 * We pick the right branch with a behavior probe rather than UA
 * sniffing: render a hidden 100 px-wide marker at a known fixed
 * offset, read back its `getBoundingClientRect`, and check whether
 * the value is closer to `100 * zoom` (visual) or `100` (layout).
 * The answer is engine-stable, so we cache it once measured.
 *
 * Ported verbatim from Claudette's `utils/zoom.ts` — the cleanest
 * known cross-engine answer.
 */

import { readZoom } from "./viewport";

type CoordSpace = "visual" | "layout";

let cachedCoordSpace: CoordSpace | null = null;

/** Exposed so dev tooling / tests can force a re-probe after mutating
 *  root zoom at runtime. Production code never calls this. */
export function resetCoordSpaceCache(): void {
  cachedCoordSpace = null;
}

/** Returns the measured coord space, or `null` when we can't actually
 *  run the probe (no DOM yet, or zoom == 1 so the two frames coincide
 *  and the measurement can't distinguish them). Callers must NOT
 *  cache `null` — the next call may have real DOM + a non-trivial
 *  zoom available. */
function probeCoordSpace(): CoordSpace | null {
  if (typeof document === "undefined" || !document.body) return null;
  const z = readZoom();
  if (z === 1) return null;
  const probe = document.createElement("div");
  // Hidden 100 px-wide marker placed at a non-zero offset. `pointer-events:
  // none` + `visibility: hidden` keep it from interfering with anything
  // on screen during the few microseconds it lives.
  probe.style.cssText =
    "position:fixed;left:100px;top:0;width:100px;height:1px;" +
    "pointer-events:none;visibility:hidden;contain:strict;";
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  document.body.removeChild(probe);
  // WebKit returns rect.left ≈ 100 * z (rect is in the visual frame).
  // Chromium returns rect.left ≈ 100 (rect is in the layout frame).
  // Pick whichever measured value is closer so sub-pixel rounding
  // doesn't tip the answer.
  const visual = 100 * z;
  const layout = 100;
  return Math.abs(rect.left - visual) < Math.abs(rect.left - layout)
    ? "visual"
    : "layout";
}

/** Returns which frame `MouseEvent.clientX/Y` live in for the current
 *  engine. Cached after the first successful probe (zoom != 1,
 *  `document.body` present). Falls back to `"visual"` when we can't
 *  measure yet — but does NOT cache that fallback, so a later call
 *  with real DOM gets a real answer. */
export function eventCoordSpace(): CoordSpace {
  if (cachedCoordSpace !== null) return cachedCoordSpace;
  const measured = probeCoordSpace();
  if (measured === null) return "visual";
  cachedCoordSpace = measured;
  return measured;
}

/** Convenience: does the current engine need the `style.left = clientX`
 *  divide-by-zoom correction? Returns the zoom factor when yes, or
 *  null when no compensation is needed (zoom == 1, or layout-frame
 *  engine). */
export function activeContextViewZoom(): number | null {
  const z = readZoom();
  if (z === 1) return null;
  if (eventCoordSpace() !== "visual") return null;
  return z;
}

/**
 * Translate `MouseEvent.clientX/Y` (from a React pointer handler) into
 * the frame `position: fixed; left/top` actually uses on the current
 * engine. Place a portal-mounted, fixed-positioned overlay at the
 * returned coordinates and it lands on the cursor under any UI zoom.
 *
 * On Chromium / at zoom 1 the two frames coincide — no-op. On WebKit
 * at zoom != 1 we divide by zoom so the visual-frame event coords
 * land in the layout frame the CSS used-value expects.
 *
 * This is the inverse of the multiply-by-zoom math I had wrong on an
 * earlier attempt; ported verbatim from Claudette's `utils/zoom.ts`.
 */
export function viewportToFixed(
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const z = readZoom();
  if (z === 1) return { x: clientX, y: clientY };
  if (eventCoordSpace() === "layout") return { x: clientX, y: clientY };
  return { x: clientX / z, y: clientY / z };
}

/**
 * Visual viewport size translated into the layout frame — the right
 * reference for clamping a fixed-positioned overlay since `left/top`
 * are layout pixels under WebKit. On Chromium / at zoom 1
 * `window.innerWidth/innerHeight` are already in the layout frame so
 * we leave them alone.
 */
export function viewportLayoutSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1024, height: 768 };
  const z = readZoom();
  if (z === 1 || eventCoordSpace() === "layout") {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  return {
    width: window.innerWidth / z,
    height: window.innerHeight / z,
  };
}

/**
 * Convenience: clamp a portal-mounted overlay's `position: fixed`
 * coordinates so the menu doesn't fall off the window edge AND it
 * lands at the cursor on any engine + zoom. Returns coords in the
 * layout frame the CSS used-value expects.
 */
export function clampFixedOverlay(
  clientX: number,
  clientY: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const { x, y } = viewportToFixed(clientX, clientY);
  const { width: vw, height: vh } = viewportLayoutSize();
  const inset = 8;
  const maxX = Math.max(inset, vw - width - inset);
  const maxY = Math.max(inset, vh - height - inset);
  return {
    x: Math.max(inset, Math.min(x, maxX)),
    y: Math.max(inset, Math.min(y, maxY)),
  };
}
