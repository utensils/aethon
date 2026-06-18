import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleSchedulerQuery } from "./schedulerQuery";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("handleSchedulerQuery", () => {
  let harness: ReturnType<typeof installTauriMocks>;
  beforeEach(() => {
    harness = installTauriMocks();
  });
  afterEach(() => {
    clearTauriMocks();
  });

  it("routes schedule_wakeup to the scheduler command", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    const task = { id: "task-1", status: "scheduled" };
    harness.invoke.mockResolvedValueOnce(task);
    handleSchedulerQuery(
      {
        type: "scheduler_query",
        op: "schedule_wakeup",
        mutationId: "m1",
        args: {
          taskId: "task-1",
          runId: "run-1",
          delayMs: 120_000,
          reason: "poll later",
        },
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.invoke).toHaveBeenCalledWith(
      "scheduled_task_schedule_wakeup",
      {
        input: {
          taskId: "task-1",
          runId: "run-1",
          delayMs: 120_000,
          reason: "poll later",
        },
      },
    );
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m1",
      true,
      undefined,
      task,
    );
  });

  it("acks failure for unknown ops", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSchedulerQuery(
      { type: "scheduler_query", op: "explode", mutationId: "m2" },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m2",
      false,
      "unknown scheduler_query op: explode",
    );
  });
});
