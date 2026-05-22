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
 * Ported from Claudette's `utils/monacoContextViewFix.ts`. Engine
 * selection uses the runtime probe in `utils/zoom-probe.ts` (a hidden
 * 100 px-wide marker and its `getBoundingClientRect`) rather than UA
 * sniffing — Tauri's webview can be either WebKit (macOS, Linux) or
 * Chromium-based depending on platform and version, and the probe
 * gives a stable answer without enumerating each one.
 */

import { activeContextViewZoom } from "../utils/zoom-probe";

interface PositionTarget {
  style: { left: string; top: string };
}

const lastApplied = new WeakMap<PositionTarget, { left: number; top: number }>();
let installed = false;
let rootObserver: MutationObserver | null = null;
const hostObservers = new WeakMap<HTMLElement, MutationObserver>();

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
  return activeContextViewZoom();
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

// Track shadow roots we've already observed so we don't double-attach
// on re-entry. WeakSet — the host element is a regular DOM node, GC
// will reclaim the entry when Monaco drops it.
const observedShadowRoots = new WeakSet<ShadowRoot>();

function watchShadowRoot(root: ShadowRoot, zoom: number | null): void {
  if (observedShadowRoots.has(root)) return;
  observedShadowRoots.add(root);
  // Pick up any `.context-view` already inside.
  for (const host of root.querySelectorAll<HTMLElement>(".context-view")) {
    if (zoom !== null) correctContextViewPosition(host, zoom);
    attachHostObserver(host);
  }
  // Walk one level deeper for any nested shadow hosts —
  // MutationObserver doesn't pierce shadow boundaries.
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if (el.shadowRoot) watchShadowRoot(el.shadowRoot, zoom);
  }
  // Subscribe to future additions inside the shadow root.
  const inner = new MutationObserver((records) => {
    const innerZoom = activeZoom();
    for (const r of records) {
      if (r.type !== "childList") continue;
      r.addedNodes.forEach((n) => visitAddedNode(n, innerZoom));
      r.removedNodes.forEach(visitRemovedNode);
    }
  });
  inner.observe(root, { childList: true, subtree: true });
}

function visitAddedNode(node: Node, zoom: number | null): void {
  if (!(node instanceof HTMLElement)) return;
  // 1. Direct/descendant `.context-view` in the light DOM.
  const hosts = node.classList?.contains("context-view")
    ? [node]
    : Array.from(node.querySelectorAll<HTMLElement>(".context-view"));
  for (const host of hosts) {
    if (zoom !== null) correctContextViewPosition(host, zoom);
    attachHostObserver(host);
  }
  // 2. Shadow roots: Monaco's StandaloneContextViewService can mount
  //    the context view INSIDE a shadow DOM. MutationObserver doesn't
  //    pierce shadow boundaries, so we have to walk explicitly.
  if (node.shadowRoot) watchShadowRoot(node.shadowRoot, zoom);
  for (const el of node.querySelectorAll<HTMLElement>("*")) {
    if (el.shadowRoot) watchShadowRoot(el.shadowRoot, zoom);
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
