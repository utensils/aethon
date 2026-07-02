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

/** Run `fn` immediately on desktop; on the mobile companion, delay it
 *  past the boot window. Returns a cancel function (no-op on desktop —
 *  `fn` already ran). */
export function scheduleAfterMobileBootWindow(fn: () => void): () => void {
  if (!isMobileSurface()) {
    fn();
    return () => {};
  }
  const timer = setTimeout(fn, MOBILE_BOOT_DEFER_MS);
  return () => clearTimeout(timer);
}
