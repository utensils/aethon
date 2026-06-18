import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleScheduledTaskRunComplete } from "./scheduledTaskRunComplete";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("handleScheduledTaskRunComplete", () => {
  let harness: ReturnType<typeof installTauriMocks>;
  beforeEach(() => {
    harness = installTauriMocks();
  });
  afterEach(() => {
    clearTauriMocks();
  });

  it("completes the Rust run and updates scheduled task state", async () => {
    const { ctx } = buildHandlerFixture({
      state: { scheduledTasks: { tasks: [{ id: "old", label: "Old" }] } },
    });
    const task = {
      id: "task-1",
      label: "Check CI",
      status: "scheduled",
      createdAt: 1,
    };
    harness.invoke.mockResolvedValueOnce(task);

    handleScheduledTaskRunComplete(
      {
        type: "scheduled_task_run_complete",
        taskId: "task-1",
        runId: "run-1",
        success: true,
        completeTask: true,
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.invoke).toHaveBeenCalledWith("scheduled_task_complete", {
      input: {
        taskId: "task-1",
        runId: "run-1",
        success: true,
        completeTask: true,
      },
    });
    expect(
      (ctx.stateRef.current.scheduledTasks as { tasks: { id: string }[] })
        .tasks[0].id,
    ).toBe("task-1");
  });
});
