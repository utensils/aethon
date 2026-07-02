import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __testing,
  buildPerfReport,
  countInvoke,
  perfMark,
  perfReport,
} from "./perfMarks";

beforeEach(() => {
  __testing.reset();
  __testing.setEnabled(true);
});

afterEach(() => {
  __testing.reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("perfMarks", () => {
  it("records prefixed marks readable in the report", () => {
    perfMark("script-start");
    perfMark("gate-first-paint");
    const report = buildPerfReport();
    expect(Object.keys(report.marks)).toEqual([
      "script-start",
      "gate-first-paint",
    ]);
  });

  it("buckets invokes into the post-hello windows", () => {
    vi.useFakeTimers();
    const base = performance.now();
    const now = vi.spyOn(performance, "now");

    now.mockReturnValue(base);
    perfMark("hello-ok");
    countInvoke("start_agent");
    now.mockReturnValue(base + 500);
    countInvoke("report");
    now.mockReturnValue(base + 3_000);
    countInvoke("git_status");
    now.mockReturnValue(base + 8_000);
    countInvoke("late_command");

    const report = buildPerfReport();
    expect(report.invokesFirst1s).toBe(2);
    expect(report.invokesFirst5s).toBe(3);
    expect(report.invokesTotal).toBe(4);
  });

  it("counts nothing before hello-ok", () => {
    countInvoke("early");
    expect(buildPerfReport().invokesFirst1s).toBe(0);
    expect(buildPerfReport().invokesTotal).toBe(1);
  });

  it("reports once, automatically after the hello-ok delay", () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    perfMark("hello-ok");
    vi.advanceTimersByTime(6_000);
    perfReport();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("is inert when disabled", () => {
    __testing.setEnabled(false);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    perfMark("hello-ok");
    countInvoke("x");
    perfReport();
    expect(info).not.toHaveBeenCalled();
    expect(buildPerfReport().invokesTotal).toBe(0);
  });
});
