/**
 * Startup timing marks for the desktop webview.
 *
 * Thin wrapper over `performance.mark` with an `aethon:boot:` prefix so
 * the boot timeline is inspectable live (aethon-debug:
 * `performance.getEntriesByType("mark")`) and summarized once as a
 * single console line when the chrome becomes ready. Marks are
 * best-effort — none of this may ever throw during boot.
 *
 * Timestamps are milliseconds since `performance.timeOrigin` (page
 * load), so the timeline reads as absolute boot progress, not deltas.
 */

const PREFIX = "aethon:boot:";

export function bootMark(name: string): void {
  try {
    performance.mark(PREFIX + name);
  } catch {
    /* environments without performance.mark — marks are best-effort */
  }
}

/** All boot marks as `{name: msSinceTimeOrigin}`, rounded to 0.1 ms. */
export function bootTimeline(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const entry of performance.getEntriesByType("mark")) {
      if (!entry.name.startsWith(PREFIX)) continue;
      out[entry.name.slice(PREFIX.length)] =
        Math.round(entry.startTime * 10) / 10;
    }
  } catch {
    /* ignore */
  }
  return out;
}

let reported = false;

/** Log the timeline once (chrome-ready). Safe to call repeatedly. */
export function reportBootTimeline(): void {
  if (reported) return;
  reported = true;
  console.info("[aethon:boot]", bootTimeline());
}

export const __testing = {
  reset(): void {
    reported = false;
    try {
      performance.clearMarks();
    } catch {
      /* ignore */
    }
  },
};
