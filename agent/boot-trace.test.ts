import { describe, expect, it } from "vitest";

import { createBootTrace, formatBootSummary } from "./boot-trace";

/** Deterministic clock: each call returns the next queued value. */
function fakeClock(...ticks: number[]): () => number {
  let i = 0;
  return () => {
    const v = ticks[Math.min(i, ticks.length - 1)];
    i += 1;
    return v;
  };
}

describe("createBootTrace", () => {
  it("records span durations in insertion order", () => {
    // created@0, a:start@10, a:end@25, b:start@30, b:end@100, total@100
    const trace = createBootTrace(fakeClock(0, 10, 25, 30, 100, 100));
    trace.span("a")();
    trace.span("b")();
    expect(trace.summary()).toEqual({ a: 15, b: 70 });
    expect(trace.totalMs()).toBe(100);
    expect(Object.keys(trace.summary())).toEqual(["a", "b"]);
  });

  it("accumulates repeated span names", () => {
    // created@0, s1:start@0, s1:end@5, s2:start@10, s2:end@30
    const trace = createBootTrace(fakeClock(0, 0, 5, 10, 30));
    trace.span("reload")();
    trace.span("reload")();
    expect(trace.summary()).toEqual({ reload: 25 });
  });

  it("ignores a second close of the same span", () => {
    // created@0, start@0, end@10, (ignored end@50), total-read@50
    const trace = createBootTrace(fakeClock(0, 0, 10, 50, 50));
    const end = trace.span("once");
    end();
    end();
    expect(trace.summary()).toEqual({ once: 10 });
  });

  it("rounds to 0.1ms", () => {
    const trace = createBootTrace(fakeClock(0, 0, 1.2345, 2.789));
    trace.span("x")();
    expect(trace.summary()).toEqual({ x: 1.2 });
    expect(trace.totalMs()).toBe(2.8);
  });

  it("measure() times an async phase and passes the result through", async () => {
    const trace = createBootTrace(fakeClock(0, 5, 47));
    const out = await trace.measure("load", () => Promise.resolve("ok"));
    expect(out).toBe("ok");
    expect(trace.summary()).toEqual({ load: 42 });
  });

  it("measure() closes the span when the phase rejects", async () => {
    const trace = createBootTrace(fakeClock(0, 5, 47));
    await expect(
      trace.measure("boom", () => Promise.reject(new Error("nope"))),
    ).rejects.toThrow("nope");
    expect(trace.summary()).toEqual({ boom: 42 });
  });
});

describe("formatBootSummary", () => {
  it("renders total plus each span", () => {
    const trace = createBootTrace(fakeClock(0, 0, 12, 12, 30, 40));
    trace.span("services-init")();
    trace.span("ensure-default-tab")();
    expect(formatBootSummary(trace)).toBe(
      "total=40ms services-init=12ms ensure-default-tab=18ms",
    );
  });
});
