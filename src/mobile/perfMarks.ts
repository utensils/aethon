/**
 * Mobile startup perf marks + boot invoke counter.
 *
 * Measures the companion's cold-start milestones (script-start →
 * gate-first-paint → connect-start → hello-ok → app-mounted →
 * first-agent-event) and counts gateway invokes in the seconds after
 * the handshake — the direct metric for the 40-invokes/s server rate
 * limit that used to drop startup data.
 *
 * Enabled in dev builds, or in release when `localStorage["aethon:perf"]`
 * is set. Everything here is best-effort and must never throw at boot.
 * The summary logs once ~6 s after `hello-ok` (covering the 5 s window)
 * and, in dev, also POSTs to the Vite server's `/__perf` endpoint so
 * on-device numbers land in the terminal without Safari attached.
 */

const PREFIX = "aethon:mobile:";
const REPORT_DELAY_MS = 6_000;
const INVOKE_CAP = 2_000;

function computeEnabled(): boolean {
  try {
    if (import.meta.env.DEV) return true;
    return localStorage.getItem("aethon:perf") !== null;
  } catch {
    return false;
  }
}

let enabled = computeEnabled();
const invokes: Array<{ cmd: string; at: number }> = [];
let helloOkAt: number | null = null;
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let reported = false;

export function perfEnabled(): boolean {
  return enabled;
}

export function perfMark(name: string): void {
  if (!enabled) return;
  try {
    performance.mark(PREFIX + name);
  } catch {
    /* marks are best-effort */
  }
  // Separate best-effort block: a throwing performance.mark must not
  // also kill report scheduling + invoke-window tracking.
  if (name === "hello-ok" && helloOkAt === null) {
    try {
      helloOkAt = performance.now();
      reportTimer = setTimeout(perfReport, REPORT_DELAY_MS);
    } catch {
      /* the report is best-effort */
    }
  }
}

/** Count one gateway invoke (called from the tauriCoreShim). */
export function countInvoke(cmd: string): void {
  if (!enabled || invokes.length >= INVOKE_CAP) return;
  try {
    invokes.push({ cmd, at: performance.now() });
  } catch {
    /* the counter is best-effort */
  }
}

function invokesWithin(windowMs: number): number {
  if (helloOkAt === null) return 0;
  const start = helloOkAt;
  return invokes.filter((i) => i.at >= start && i.at <= start + windowMs)
    .length;
}

export interface MobilePerfReport {
  marks: Record<string, number>;
  invokesFirst1s: number;
  invokesFirst5s: number;
  invokesTotal: number;
}

export function buildPerfReport(): MobilePerfReport {
  const marks: Record<string, number> = {};
  try {
    for (const entry of performance.getEntriesByType("mark")) {
      if (!entry.name.startsWith(PREFIX)) continue;
      marks[entry.name.slice(PREFIX.length)] =
        Math.round(entry.startTime * 10) / 10;
    }
  } catch {
    /* ignore */
  }
  return {
    marks,
    invokesFirst1s: invokesWithin(1_000),
    invokesFirst5s: invokesWithin(5_000),
    invokesTotal: invokes.length,
  };
}

/** Log (and in dev, beacon) the report once. Safe to call repeatedly. */
export function perfReport(): void {
  if (!enabled || reported) return;
  reported = true;
  if (reportTimer !== null) {
    clearTimeout(reportTimer);
    reportTimer = null;
  }
  const payload = buildPerfReport();
  console.info("[aethon:mobile-perf]", payload);
  if (import.meta.env.DEV) {
    try {
      void fetch("/__perf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch {
      /* relative fetch unavailable outside the dev server — ignore */
    }
  }
}

export const __testing = {
  reset(): void {
    invokes.length = 0;
    helloOkAt = null;
    reported = false;
    enabled = computeEnabled();
    if (reportTimer !== null) {
      clearTimeout(reportTimer);
      reportTimer = null;
    }
    try {
      performance.clearMarks();
    } catch {
      /* ignore */
    }
  },
  setEnabled(value: boolean): void {
    enabled = value;
  },
};
