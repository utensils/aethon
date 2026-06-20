import type { BridgeMessageHandler } from "./types";
import {
  cancelScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  pauseScheduledTask,
  resumeScheduledTask,
  runScheduledTaskNow,
  scheduleLoopWakeup,
} from "../../scheduledTasks";

export const handleSchedulerQuery: BridgeMessageHandler = (data, ctx) => {
  const op = typeof data.op === "string" ? data.op : "";
  const args = (data.args as Record<string, unknown> | undefined) ?? {};
  const mid = data.mutationId;

  const route = async (): Promise<unknown> => {
    if (op === "list") {
      return await listScheduledTasks();
    }
    if (op === "schedule_wakeup") {
      const taskId = args.taskId;
      if (typeof taskId !== "string" || !taskId) {
        throw new Error("schedule_wakeup requires taskId");
      }
      return await scheduleLoopWakeup({
        taskId,
        ...(typeof args.runId === "string" ? { runId: args.runId } : {}),
        ...(typeof args.nextRunAt === "number"
          ? { nextRunAt: args.nextRunAt }
          : {}),
        ...(typeof args.delayMs === "number" ? { delayMs: args.delayMs } : {}),
        ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
      });
    }
    if (
      op === "cancel" ||
      op === "delete" ||
      op === "pause" ||
      op === "resume" ||
      op === "run_now"
    ) {
      const taskId = args.taskId;
      if (typeof taskId !== "string" || !taskId) {
        throw new Error(`${op} requires taskId`);
      }
      if (op === "cancel") return await cancelScheduledTask(taskId);
      if (op === "delete") return await deleteScheduledTask(taskId);
      if (op === "pause") return await pauseScheduledTask(taskId);
      if (op === "resume") return await resumeScheduledTask(taskId);
      return await runScheduledTaskNow(taskId);
    }
    throw new Error(`unknown scheduler_query op: ${op}`);
  };

  route()
    .then((result) => ctx.ackMutation(mid, true, undefined, result))
    .catch((err: unknown) => {
      ctx.ackMutation(
        mid,
        false,
        err instanceof Error ? err.message : String(err),
      );
    });
};
