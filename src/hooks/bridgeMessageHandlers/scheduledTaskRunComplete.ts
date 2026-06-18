import type { BridgeMessageHandler } from "./types";
import {
  completeScheduledTaskRun,
  type ScheduledTaskRecord,
} from "../../scheduledTasks";

export const handleScheduledTaskRunComplete: BridgeMessageHandler = (
  data,
  ctx,
) => {
  const taskId = data.taskId;
  const runId = data.runId;
  if (typeof taskId !== "string" || typeof runId !== "string") return;
  completeScheduledTaskRun({
    taskId,
    runId,
    success: data.success !== false,
    ...(typeof data.error === "string" ? { error: data.error } : {}),
    ...(data.completeTask === true ? { completeTask: true } : {}),
  })
    .then((task) => {
      ctx.setState((prev) => {
        const cur =
          (prev.scheduledTasks as
            | { tasks?: ScheduledTaskRecord[] }
            | undefined) ?? {};
        const tasks = [
          task,
          ...(cur.tasks ?? []).filter((item) => item.id !== task.id),
        ];
        return { ...prev, scheduledTasks: { ...cur, tasks } };
      });
    })
    .catch((err: unknown) => {
      ctx.pushNotification({
        title: "Scheduled task did not complete cleanly",
        message: err instanceof Error ? err.message : String(err),
        kind: "warning",
      });
    });
};
