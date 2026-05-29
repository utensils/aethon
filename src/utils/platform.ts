/**
 * Platform detection for the webview frontend. Used to gate macOS-only
 * chrome (the overlay titlebar / traffic-light clearance) so Linux and
 * Windows render unchanged.
 *
 * Mirrors the inline idiom previously inlined at `config.ts` for the
 * voice push-to-talk hotkey — keep both in sync if the matcher changes.
 */

/** True when running on macOS (best-effort UA/platform sniff). */
export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
}
