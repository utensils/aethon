import { describe, expect, it } from "vitest";
import { handleScheduledTasks } from "./scheduledTasks";
import { buildRouteFixture } from "./testFixtures";

describe("handleScheduledTasks", () => {
  it("closes the scheduled tasks modal on close events", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        scheduledTasks: {
          open: true,
          tasks: [{ id: "task-1", label: "Daily check" }],
        },
      },
    });

    const handled = await handleScheduledTasks(
      { component: { id: "scheduled-tasks-panel" }, eventType: "close" },
      ctx,
    );

    expect(handled).toBe(true);
    expect(applySetState().scheduledTasks).toEqual({
      open: false,
      tasks: [{ id: "task-1", label: "Daily check" }],
    });
  });

  it("returns false for non-close events", async () => {
    const { ctx, mocks } = buildRouteFixture();

    const handled = await handleScheduledTasks(
      { component: { id: "scheduled-tasks-panel" }, eventType: "submit" },
      ctx,
    );

    expect(handled).toBe(false);
    expect(mocks.setState).not.toHaveBeenCalled();
  });
});
