/**
 * macOS window-drag helper for the overlay-titlebar chrome.
 *
 * Under `titleBarStyle: Overlay` there's no native bar to grab, so marked
 * chrome (the header strip + sidebar brand) must drag the window itself. Two
 * things are needed for this to work on Tauri 2 + WKWebView, and both were
 * missing:
 *
 *  1. The `core:window:allow-start-dragging` /
 *     `core:window:allow-internal-toggle-maximize` permissions in
 *     `capabilities/default.json`. Without them Tauri's ACL rejects the IPC
 *     server-side — the invoke fires but the window never moves.
 *  2. An explicit mousedown handler. The `@tauri-apps/api/window`
 *     `getCurrentWindow().startDragging()` wrapper rejects before reaching the
 *     internal invoke in this webview, so we call Tauri's internal invoke
 *     directly (`plugin:window|start_dragging`) — exactly as the injected
 *     `drag.js` does. This is also how the reference app (../claudette) does
 *     it.
 *
 * `onWindowDragMouseDown` is the single entry point: a left-click on
 * non-interactive chrome starts a drag; a double-click toggles maximize
 * (matching native titlebar behavior). The `isInteractiveTarget` guard lets
 * clicks on buttons / inputs / links reach their handlers instead.
 */

import type { MouseEvent as ReactMouseEvent } from "react";

// Mirror Tauri's own drag.js clickable detection so our guard agrees with
// the native handler about what counts as interactive.
const INTERACTIVE_TAGS = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "LABEL",
  "SUMMARY",
]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
  "slider",
  "textbox",
  "combobox",
]);

/**
 * True when the click target is (or sits within) an interactive control
 * between the event target and the drag-region `boundary` element. Such
 * clicks must NOT start a window drag — they belong to the control.
 */
export function isInteractiveTarget(
  target: EventTarget | null,
  boundary: Element,
): boolean {
  let el = target instanceof HTMLElement ? target : null;
  while (el && el !== boundary) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && tabindex !== "-1") return true;
    if (
      el.getAttribute("data-tauri-drag-region") === "false" ||
      el.hasAttribute("data-no-drag")
    ) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

interface TauriInternals {
  invoke?: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
}

/**
 * Fire a `plugin:window|*` command through Tauri's internal invoke. We use
 * the internal entry point rather than `@tauri-apps/api/window` because the
 * high-level wrapper rejects before reaching it in this webview. Best-effort
 * — a no-op off-Tauri; logs (rather than throws) on rejection.
 */
function invokeWindow(command: string): void {
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
  ).__TAURI_INTERNALS__;
  try {
    const result = internals?.invoke?.(`plugin:window|${command}`);
    if (result && typeof result.then === "function") {
      result.catch((err: unknown) => {
        console.error(`${command} failed:`, err);
      });
    }
  } catch (err) {
    console.error(`${command} threw:`, err);
  }
}

/** Begin a native window drag. */
export function startWindowDrag(): void {
  invokeWindow("start_dragging");
}

/** Toggle maximize/restore — the native double-click-titlebar action. */
export function toggleMaximizeWindow(): void {
  invokeWindow("internal_toggle_maximize");
}

/**
 * Shared mousedown handler for drag-region chrome (header, sidebar brand).
 * Single left-click on non-interactive chrome → drag; double-click → toggle
 * maximize. Pass an explicit `boundary` when the handler is attached above
 * the element that owns the drag region; defaults to `currentTarget`.
 */
export function onWindowDragMouseDown(
  event: ReactMouseEvent<HTMLElement>,
  boundary?: Element,
): void {
  if (event.button !== 0) return;
  if (isInteractiveTarget(event.target, boundary ?? event.currentTarget)) {
    return;
  }
  event.preventDefault();
  if (event.detail >= 2) {
    toggleMaximizeWindow();
  } else {
    startWindowDrag();
  }
}
