import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { AethonAgentState, MutationResult } from "./state";
import type { DispatcherDeps } from "./dispatcherTypes";
import { trackMutation } from "./mutation-ack";

const FRONTEND_READY_TIMEOUT_MS = 5_000;

async function schedulerQuery(
  state: AethonAgentState,
  deps: Pick<DispatcherDeps, "send">,
  op: string,
  args: Record<string, unknown>,
): Promise<MutationResult> {
  if (!state.frontendReady) {
    const ready = await Promise.race<boolean>([
      state.frontendReadyPromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), FRONTEND_READY_TIMEOUT_MS),
      ),
    ]);
    if (!ready) return { ok: false, error: "frontend_not_ready" };
  }
  const { id, promise } = trackMutation(state);
  deps.send({ type: "scheduler_query", mutationId: id, op, args });
  return promise;
}

const ScheduleNextLoopWakeupParams = Type.Object({
  taskId: Type.String({
    description: "Scheduled task id from the current Aethon scheduled run.",
  }),
  runId: Type.String({
    description: "Scheduled run id from the current Aethon scheduled run.",
  }),
  delayMinutes: Type.Optional(
    Type.Number({
      description:
        "Minutes from now until Aethon should wake this loop again. Use this or nextRunAt.",
      minimum: 1,
    }),
  ),
  nextRunAt: Type.Optional(
    Type.Number({
      description:
        "Unix epoch milliseconds for the next wakeup. Must be in the future and within the task lifetime.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: "Short reason shown in the Scheduled Tasks manager.",
    }),
  ),
});
type ScheduleNextLoopWakeupParamsT = Static<
  typeof ScheduleNextLoopWakeupParams
>;

const CompleteLoopTaskParams = Type.Object({
  taskId: Type.String({
    description: "Scheduled task id from the current Aethon scheduled run.",
  }),
  runId: Type.String({
    description: "Scheduled run id from the current Aethon scheduled run.",
  }),
  reason: Type.Optional(
    Type.String({
      description: "Short completion note for the current loop.",
    }),
  ),
});
type CompleteLoopTaskParamsT = Static<typeof CompleteLoopTaskParams>;

export function buildSchedulerTools(
  state: AethonAgentState,
  deps: DispatcherDeps,
  tabId: string,
): ToolDefinition[] {
  const scheduleNextTool = defineTool({
    name: "scheduleNextLoopWakeup",
    label: "Schedule next loop wakeup",
    description:
      "For a self-paced Aethon /loop run, choose when the same task should wake up next. Call this before ending the turn when more follow-up work is useful.",
    promptSnippet:
      "scheduleNextLoopWakeup: set the next wake time for the current self-paced Aethon loop",
    parameters: ScheduleNextLoopWakeupParams,
    async execute(_callId: string, params: ScheduleNextLoopWakeupParamsT) {
      const delayMs =
        typeof params.delayMinutes === "number"
          ? Math.max(1, Math.round(params.delayMinutes)) * 60_000
          : undefined;
      if (delayMs === undefined && typeof params.nextRunAt !== "number") {
        throw new Error("delayMinutes or nextRunAt required");
      }
      const r = await schedulerQuery(state, deps, "schedule_wakeup", {
        taskId: params.taskId,
        runId: params.runId,
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(typeof params.nextRunAt === "number"
          ? { nextRunAt: params.nextRunAt }
          : {}),
        ...(typeof params.reason === "string" && params.reason.trim()
          ? { reason: params.reason.trim() }
          : {}),
      });
      if (!r.ok) throw new Error(r.error ?? "unknown scheduler error");
      const rec = state.tabs.get(tabId);
      if (
        rec?.scheduledRun?.taskId === params.taskId &&
        rec.scheduledRun.runId === params.runId
      ) {
        rec.scheduledRun.wakeupScheduled = true;
      }
      return {
        content: [{ type: "text" as const, text: "next wakeup scheduled" }],
        details: r.data ?? null,
      };
    },
  }) as ToolDefinition;

  const completeLoopTool = defineTool({
    name: "completeLoopTask",
    label: "Complete loop task",
    description:
      "Mark the current self-paced Aethon loop as complete. Use this when the loop should not wake again.",
    promptSnippet:
      "completeLoopTask: finish the current self-paced Aethon loop without scheduling another wakeup",
    parameters: CompleteLoopTaskParams,
    execute(_callId: string, params: CompleteLoopTaskParamsT) {
      const rec = state.tabs.get(tabId);
      if (
        rec?.scheduledRun?.taskId !== params.taskId ||
        rec.scheduledRun.runId !== params.runId
      ) {
        throw new Error("taskId/runId do not match the current scheduled run");
      }
      rec.scheduledRun.completeRequested = true;
      return {
        content: [{ type: "text" as const, text: "loop marked complete" }],
        details:
          typeof params.reason === "string" && params.reason.trim()
            ? { reason: params.reason.trim() }
            : {},
      };
    },
  }) as ToolDefinition;

  return [scheduleNextTool, completeLoopTool];
}
