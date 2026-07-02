/**
 * Boot-phase timing spans for the bridge.
 *
 * `main()` creates one trace and wraps each serial boot phase in a span
 * so the summary at `ready` / `worker_ready` shows where cold-start time
 * went (extension loads, resource reloads, default-tab creation, …).
 * The caller decides where the summary goes — the boot log line plus a
 * `boot_timings` IPC frame the frontend can ignore or chart.
 *
 * Repeated span names accumulate (a phase that runs twice reports the
 * sum), so call sites need no uniqueness bookkeeping. Closing a span
 * twice is a no-op.
 */

export interface BootTrace {
  /** Start a span; call the returned closer to end it. */
  span(name: string): () => void;
  /** Wrap an async phase in a span. */
  measure<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Milliseconds per span, insertion order, rounded to 0.1 ms. */
  summary(): Record<string, number>;
  /** Milliseconds since the trace was created, rounded to 0.1 ms. */
  totalMs(): number;
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

export function createBootTrace(
  now: () => number = () => performance.now(),
): BootTrace {
  const started = now();
  const spans = new Map<string, number>();
  const span = (name: string): (() => void) => {
    const begin = now();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      spans.set(name, (spans.get(name) ?? 0) + (now() - begin));
    };
  };
  return {
    span,
    async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const end = span(name);
      try {
        return await fn();
      } finally {
        end();
      }
    },
    summary(): Record<string, number> {
      const out: Record<string, number> = {};
      for (const [name, ms] of spans) out[name] = round(ms);
      return out;
    },
    totalMs(): number {
      return round(now() - started);
    },
  };
}

/** One-line boot-log summary: `total=812.4ms services-init=12.1ms …`. */
export function formatBootSummary(trace: BootTrace): string {
  const parts = Object.entries(trace.summary()).map(
    ([name, ms]) => `${name}=${ms}ms`,
  );
  return `total=${trace.totalMs()}ms ${parts.join(" ")}`;
}
