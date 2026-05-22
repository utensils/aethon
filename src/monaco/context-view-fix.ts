/**
 * Patch Monaco's `.context-view` positioning under html-level CSS `zoom`.
 *
 * Monaco renders its right-click menu, completion list, and quick-input
 * picker into a single `position: fixed` element with class
 * `.context-view`. Its position is computed from `MouseEvent.clientX/Y`
 * (or `getBoundingClientRect()` of an anchor) and written directly to
 * `style.left` / `style.top`. Engines disagree on whether those
 * coordinates live in **visual** (post-zoom) or **layout** (pre-zoom)
 * pixels:
 *
 *   - WebKit (WKWebView, WebKitGTK): event coords + rects are reported
 *     in visual pixels, but CSS `left/top` are interpreted in layout
 *     pixels. The menu lands at `visual = clientX * zoom`, drifting
 *     past the cursor at any zoom != 1.
 *   - Chromium (WebView2): zoom is uniform across the whole pipeline —
 *     no compensation needed.
 *
 * Monaco issue #1203 (open since 2018) explicitly notes that
 * `fixedOverflowWidgets` doesn't reach the context view, so we can't
 * fix this through the editor options. The pragmatic workaround is to
 * observe `.context-view` mounts, divide `style.left/top` by the
 * active zoom on engines that need it, and leave everything else
 * (menu contents, keyboard nav, focus) untouched.
 *
 * Ported from Claudette's `utils/monacoContextViewFix.ts`. Trimmed: we
 * skip the shadow-root walk (Monaco doesn't currently nest shadow
 * DOM, and Aethon doesn't render anything else into one) and the
 * coord-space probe (Tauri only ships WebKit/WKWebView on macOS +
 * Linux + WebView2 on Windows; we detect via UA fingerprint to keep
 * the install side-effect-free and synchronous).
 */

import { readZoom } from "../utils/viewport";

interface PositionTarget {
  style: { left: string; top: string };
}

const lastApplied = new WeakMap<PositionTarget, { left: number; top: number }>();
let installed = false;
let rootObserver: MutationObserver | null = null;
const hostObservers = new WeakMap<HTMLElement, MutationObserver>();

/** Returns true on engines where event coords are reported in visual
 *  pixels while CSS fixed positions are layout pixels — i.e. the
 *  combinations that need the divide. Tauri uses WKWebView on macOS
 *  and WebKitGTK on Linux (both WebKit). Windows ships WebView2
 *  (Chromium). We trust the UA string here rather than running the
 *  rect-probe Claudette uses; it costs a layout reflow and Aethon's
 *  target platforms are well-known. */
function isVisualCoordEngine(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // WebKit fingerprint: "AppleWebKit/..." present AND no "Chrome/" —
  // Chromium-based browsers also carry "AppleWebKit/" but include
  // "Chrome/" too. WKWebView and Safari do not.
  return /AppleWebKit\//.test(ua) && !/Chrome\//.test(ua);
}

/** Pure correction — exported for tests. Returns true when a write
 *  was applied. Skips on unparseable coords or echo-of-own-write. */
export function correctContextViewPosition(
  el: PositionTarget,
  zoom: number,
): boolean {
  const left = parseFloat(el.style.left);
  const top = parseFloat(el.style.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return false;

  const last = lastApplied.get(el);
  if (
    last &&
    Math.abs(last.left - left) < 0.5 &&
    Math.abs(last.top - top) < 0.5
  ) {
    return false;
  }

  const correctedLeft = left / zoom;
  const correctedTop = top / zoom;
  el.style.left = `${correctedLeft}px`;
  el.style.top = `${correctedTop}px`;
  lastApplied.set(el, { left: correctedLeft, top: correctedTop });
  return true;
}

function activeZoom(): number | null {
  if (!isVisualCoordEngine()) return null;
  const z = readZoom();
  return z === 1 ? null : z;
}

function attachHostObserver(host: HTMLElement): void {
  if (hostObservers.has(host)) return;
  const inner = new MutationObserver(() => {
    const z = activeZoom();
    if (z === null) return;
    correctContextViewPosition(host, z);
  });
  inner.observe(host, { attributes: true, attributeFilter: ["style"] });
  hostObservers.set(host, inner);
}

function detachHostObserver(host: HTMLElement): void {
  const inner = hostObservers.get(host);
  if (!inner) return;
  inner.disconnect();
  hostObservers.delete(host);
}

function visitAddedNode(node: Node, zoom: number | null): void {
  if (!(node instanceof HTMLElement)) return;
  const hosts = node.classList?.contains("context-view")
    ? [node]
    : Array.from(node.querySelectorAll<HTMLElement>(".context-view"));
  for (const host of hosts) {
    if (zoom !== null) correctContextViewPosition(host, zoom);
    attachHostObserver(host);
  }
}

function visitRemovedNode(node: Node): void {
  if (!(node instanceof HTMLElement)) return;
  if (node.classList?.contains("context-view")) {
    detachHostObserver(node);
  }
  for (const host of node.querySelectorAll<HTMLElement>(".context-view")) {
    detachHostObserver(host);
  }
}

/** Install the document-wide observer. Idempotent. Safe to call before
 *  `document.body` exists (defers via DOMContentLoaded). The fix only
 *  takes effect on WebKit at zoom != 1; on Chromium and at zoom == 1
 *  every callback short-circuits, so the runtime cost is just the
 *  observer subscriptions themselves. */
export function installMonacoContextViewFix(): void {
  if (installed) return;
  if (typeof document === "undefined") return;
  installed = true;

  const start = () => {
    rootObserver = new MutationObserver((records) => {
      const z = activeZoom();
      for (const r of records) {
        if (r.type !== "childList") continue;
        r.addedNodes.forEach((n) => visitAddedNode(n, z));
        r.removedNodes.forEach(visitRemovedNode);
      }
    });
    rootObserver.observe(document.body, { childList: true, subtree: true });
    // Seed: catch any `.context-view` that already exists when we
    // installed (Monaco mounts its persistent host element on first
    // editor.create, which usually runs before this).
    const seedZoom = activeZoom();
    visitAddedNode(document.body, seedZoom);
  };

  if (document.body) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
}

/** Test-only: reset module state between cases. */
export const __testing = {
  reset(): void {
    rootObserver?.disconnect();
    rootObserver = null;
    installed = false;
  },
};
