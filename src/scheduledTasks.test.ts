import { describe, expect, it } from "vitest";
import { parseLoopArgs } from "./scheduledTasks";

describe("parseLoopArgs", () => {
  it("creates a self-paced loop with no args", () => {
    expect(parseLoopArgs("")).toEqual({
      ok: true,
      mode: "loopSelfPaced",
      schedule: { kind: "selfPaced" },
      prompt: "",
    });
  });

  it("parses fixed interval shorthand", () => {
    expect(parseLoopArgs("30m check CI")).toEqual({
      ok: true,
      mode: "loopFixed",
      schedule: { kind: "interval", intervalMs: 30 * 60_000, label: "30m" },
      prompt: "check CI",
    });
  });

  it("parses every-prefixed intervals", () => {
    expect(parseLoopArgs("every 2h summarize open PRs")).toEqual({
      ok: true,
      mode: "loopFixed",
      schedule: { kind: "interval", intervalMs: 2 * 60 * 60_000, label: "2h" },
      prompt: "summarize open PRs",
    });
    expect(parseLoopArgs("every 2 hours summarize open PRs")).toEqual({
      ok: true,
      mode: "loopFixed",
      schedule: { kind: "interval", intervalMs: 2 * 60 * 60_000, label: "2h" },
      prompt: "summarize open PRs",
    });
    expect(parseLoopArgs("every 2h")).toEqual({
      ok: true,
      mode: "loopFixed",
      schedule: { kind: "interval", intervalMs: 2 * 60 * 60_000, label: "2h" },
      prompt: "",
    });
  });

  it("rejects intervals under one minute", () => {
    const parsed = parseLoopArgs("30s ping");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("at least 1 minute");
  });

  it("treats non-interval text as a self-paced prompt", () => {
    expect(parseLoopArgs("check the repo and decide the next wakeup")).toEqual({
      ok: true,
      mode: "loopSelfPaced",
      schedule: { kind: "selfPaced" },
      prompt: "check the repo and decide the next wakeup",
    });
  });
});
