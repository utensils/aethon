import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { parseLoopArgs, reuseScheduledTask } from "./scheduledTasks";

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

describe("reuseScheduledTask", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the native reuse command with the active session binding", async () => {
    const record = { id: "task-1", status: "scheduled" };
    invokeMock.mockResolvedValueOnce(record);

    await expect(
      reuseScheduledTask({
        taskId: "task-1",
        tabId: "tab-2",
        cwd: "/repo",
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "high",
        hardEnforce: true,
        authProfileId: "openai-primary",
      }),
    ).resolves.toBe(record);

    expect(invokeMock).toHaveBeenCalledWith("scheduled_task_reuse", {
      input: {
        taskId: "task-1",
        tabId: "tab-2",
        cwd: "/repo",
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "high",
        hardEnforce: true,
        authProfileId: "openai-primary",
      },
    });
  });
});
