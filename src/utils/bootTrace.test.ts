import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __testing,
  bootMark,
  bootTimeline,
  reportBootTimeline,
} from "./bootTrace";

afterEach(() => {
  __testing.reset();
  vi.restoreAllMocks();
});

describe("bootTrace", () => {
  it("records prefixed marks and reads them back by name", () => {
    bootMark("main-eval");
    bootMark("react-mounted");
    const timeline = bootTimeline();
    expect(Object.keys(timeline)).toEqual(["main-eval", "react-mounted"]);
    expect(timeline["main-eval"]).toBeGreaterThanOrEqual(0);
    expect(timeline["react-mounted"]).toBeGreaterThanOrEqual(
      timeline["main-eval"],
    );
  });

  it("ignores marks without the aethon prefix", () => {
    performance.mark("someone-elses-mark");
    bootMark("chrome-ready");
    expect(Object.keys(bootTimeline())).toEqual(["chrome-ready"]);
    performance.clearMarks("someone-elses-mark");
  });

  it("reports the timeline exactly once", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    bootMark("chrome-ready");
    reportBootTimeline();
    reportBootTimeline();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[aethon:boot]",
      expect.objectContaining({ "chrome-ready": expect.any(Number) }),
    );
  });

  it("never throws when the performance API misbehaves", () => {
    const original = performance.mark.bind(performance);
    vi.spyOn(performance, "mark").mockImplementation(() => {
      throw new Error("no marks here");
    });
    expect(() => bootMark("x")).not.toThrow();
    performance.mark = original;
  });
});
