/**
 * Mobile-surface boot deferral.
 *
 * The companion reuses the desktop hooks, whose mount effects were
 * written for in-process IPC (~µs). Over the gateway every call is a
 * WebSocket round-trip against a 40-invokes/s server budget, and the
 * boot burst (per-project git_status + git_fetch_all + icon discovery)
 * competed with hydration for it. Desktop-critical data is unaffected:
 * chips paint from the persisted cache, and the active root's vcs
 * status still refreshes immediately.
 */

export const MOBILE_BOOT_DEFER_MS = 10_000;

export function isMobileSurface(): boolean {
  return import.meta.env.VITE_AETHON_SURFACE === "mobile";
}

let bootStartedAt = Date.now();

/** True once the mobile boot window has passed (always true on the
 *  desktop surface). Effects that re-fire during hydration use this so
 *  a re-run can't sneak past a first-run-only deferral. */
export function mobileBootWindowElapsed(): boolean {
  if (!isMobileSurface()) return true;
  return Date.now() - bootStartedAt > MOBILE_BOOT_DEFER_MS;
}

/** Test-only: restart the boot window. */
export function resetMobileBootWindowForTest(): void {
  bootStartedAt = Date.now();
}

/** Run `fn` immediately on desktop (or once the window has already
 *  passed); on the mobile companion inside the boot window, delay it to
 *  the END of the window — not a full window from call time, so a call
 *  8s into boot fires at ~10s, not ~18s. Returns a cancel function
 *  (no-op when `fn` already ran). */
export function scheduleAfterMobileBootWindow(fn: () => void): () => void {
  const remaining = MOBILE_BOOT_DEFER_MS - (Date.now() - bootStartedAt);
  if (!isMobileSurface() || remaining <= 0) {
    fn();
    return () => {};
  }
  const timer = setTimeout(fn, remaining);
  return () => clearTimeout(timer);
}
