import { describe, expect, it } from "vitest";
import type { DispatcherDeps } from "./dispatcherTypes";
import { ackMutation, markFrontendReady } from "./mutation-ack";
import { buildSchedulerTools } from "./scheduler-tools";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type TabRecord,
} from "./state";

const baseOpts: AethonAgentStateOptions = {
  userDir: "/tmp/aethon-test",
  stateFile: "/tmp/aethon-test/state.json",
  sessionsDir: "/tmp/aethon-test/sessions",
  docsDir: undefined,
  projectRoot: undefined,
  releaseMode: false,
  bootLayoutFile: undefined,
  layoutSlotsFile: undefined,
  statePayloadWarnBytes: 64 * 1024,
  statePayloadHardBytes: 512 * 1024,
  statePayloadWarnKb: 64,
  statePayloadHardKb: 512,
};

function makeFixture() {
  const state = new AethonAgentState(baseOpts);
  const sent: Record<string, unknown>[] = [];
  const deps = {
    send: (message: Record<string, unknown>) => sent.push(message),
  } as unknown as DispatcherDeps;
  state.tabs.set("tab-1", {
    scheduledRun: { taskId: "task-1", runId: "run-1" },
  } as TabRecord);
  return { state, sent, deps };
}

function getTool(name: string) {
  const { state, deps } = makeFixture();
  const tool = buildSchedulerTools(state, deps, "tab-1").find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`tool ${name} not in catalogue`);
  return tool;
}

describe("buildSchedulerTools", () => {
  it("registers loop scheduler tools", () => {
    expect(
      buildSchedulerTools(
        new AethonAgentState(baseOpts),
        { send: () => {} } as unknown as DispatcherDeps,
        "tab-1",
      )
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["completeLoopTask", "scheduleNextLoopWakeup"]);
  });
});

describe("scheduleNextLoopWakeup", () => {
  it("sends a scheduler query and marks the current scheduled run", async () => {
    const { state, sent, deps } = makeFixture();
    markFrontendReady(state);
    const tool = buildSchedulerTools(state, deps, "tab-1").find(
      (candidate) => candidate.name === "scheduleNextLoopWakeup",
    );
    if (!tool) throw new Error("tool not found");

    const resultPromise = tool.execute("call-1", {
      taskId: "task-1",
      runId: "run-1",
      delayMinutes: 2,
      reason: "poll later",
    });

    const msg = sent.at(-1);
    expect(msg).toMatchObject({
      type: "scheduler_query",
      op: "schedule_wakeup",
      args: {
        taskId: "task-1",
        runId: "run-1",
        delayMs: 120_000,
        reason: "poll later",
      },
    });
    ackMutation(state, msg?.mutationId as string, true, undefined, {
      id: "task-1",
    });
    await expect(resultPromise).resolves.toMatchObject({
      details: { id: "task-1" },
    });
    expect(state.tabs.get("tab-1")?.scheduledRun?.wakeupScheduled).toBe(true);
  });

  it("requires a concrete wakeup time", async () => {
    await expect(
      getTool("scheduleNextLoopWakeup").execute("call-1", {
        taskId: "task-1",
        runId: "run-1",
      }),
    ).rejects.toThrow("delayMinutes or nextRunAt required");
  });
});

describe("completeLoopTask", () => {
  it("marks the current scheduled run complete", () => {
    const { state, deps } = makeFixture();
    const tool = buildSchedulerTools(state, deps, "tab-1").find(
      (candidate) => candidate.name === "completeLoopTask",
    );
    if (!tool) throw new Error("tool not found");

    const result = tool.execute("call-1", {
      taskId: "task-1",
      runId: "run-1",
      reason: "done",
    });

    expect(state.tabs.get("tab-1")?.scheduledRun?.completeRequested).toBe(true);
    expect(result).toMatchObject({ details: { reason: "done" } });
  });

  it("rejects task/run ids outside the current scheduled run", () => {
    expect(() =>
      getTool("completeLoopTask").execute("call-1", {
        taskId: "task-2",
        runId: "run-1",
      }),
    ).toThrow("taskId/runId do not match");
  });
});
