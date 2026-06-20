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

const ManageScheduledTasksParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("cancel"),
      Type.Literal("delete"),
      Type.Literal("pause"),
      Type.Literal("resume"),
      Type.Literal("run"),
    ],
    {
      description:
        "Scheduler action. Use list first when task ids are unknown. Use cancel with all=true to stop active loop tasks, or delete with all=true to remove loop records.",
    },
  ),
  taskId: Type.Optional(
    Type.String({
      description:
        "Full task id or unique task id prefix for cancel, pause, resume, or run.",
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description:
        "Apply cancel/pause/resume/delete to all matching loop tasks. Delete skips running tasks. Not supported for run.",
    }),
  ),
});
type ManageScheduledTasksParamsT = Static<typeof ManageScheduledTasksParams>;

export function buildSchedulerTools(
  state: AethonAgentState,
  deps: DispatcherDeps,
  tabId: string,
): ToolDefinition[] {
  const manageTasksTool = defineTool({
    name: "manageScheduledTasks",
    label: "Manage scheduled tasks",
    description:
      "List, cancel, pause, resume, or run Aethon scheduled tasks and loops. Use this for user requests like stop all loops or show scheduled tasks.",
    promptSnippet:
      "manageScheduledTasks: list or manage Aethon scheduled tasks by id, prefix, or all loops",
    parameters: ManageScheduledTasksParams,
    async execute(_callId: string, params: ManageScheduledTasksParamsT) {
      const tasks = await listTasks(state, deps);
      if (params.action === "list") {
        return {
          content: [{ type: "text" as const, text: summarizeTasks(tasks) }],
          details: { tasks },
        };
      }
      if (params.all === true) {
        if (params.action === "run") {
          throw new Error("run does not support all=true");
        }
        const targets = tasks.filter((task) =>
          isBulkManageTarget(task, params.action),
        );
        const results = [];
        for (const task of targets) {
          results.push(await manageTask(state, deps, params.action, task.id));
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                results.length === 0
                  ? `no active loops to ${params.action}`
                  : `${params.action} applied to ${results.length} loop task${results.length === 1 ? "" : "s"}`,
            },
          ],
          details: { tasks: results },
        };
      }
      if (!params.taskId?.trim()) {
        throw new Error("taskId or all=true required");
      }
      const target = resolveTask(tasks, params.taskId);
      const updated = await manageTask(state, deps, params.action, target.id);
      return {
        content: [
          {
            type: "text" as const,
            text: `${params.action} applied to ${taskTitle(updated)}`,
          },
        ],
        details: updated,
      };
    },
  }) as ToolDefinition;

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

  return [manageTasksTool, scheduleNextTool, completeLoopTool];
}

interface ScheduledTaskShape {
  id: string;
  label?: string;
  mode?: string;
  status?: string;
  nextRunAt?: number | null;
  promptSource?: string;
}

async function listTasks(
  state: AethonAgentState,
  deps: DispatcherDeps,
): Promise<ScheduledTaskShape[]> {
  const r = await schedulerQuery(state, deps, "list", {});
  if (!r.ok) throw new Error(r.error ?? "unknown scheduler error");
  if (!Array.isArray(r.data)) return [];
  return r.data.filter(isScheduledTaskShape);
}

async function manageTask(
  state: AethonAgentState,
  deps: DispatcherDeps,
  action: Exclude<ManageScheduledTasksParamsT["action"], "list">,
  taskId: string,
): Promise<ScheduledTaskShape> {
  const op = action === "run" ? "run_now" : action;
  const r = await schedulerQuery(state, deps, op, { taskId });
  if (!r.ok) throw new Error(r.error ?? "unknown scheduler error");
  if (!isScheduledTaskShape(r.data)) {
    throw new Error(`scheduler ${action} returned an invalid task`);
  }
  return r.data;
}

function isScheduledTaskShape(value: unknown): value is ScheduledTaskShape {
  if (!value || typeof value !== "object") return false;
  const rec = value as ScheduledTaskShape;
  return typeof rec.id === "string" && rec.id.length > 0;
}

function resolveTask(
  tasks: ScheduledTaskShape[],
  prefix: string,
): ScheduledTaskShape {
  const needle = prefix.trim();
  const matches = tasks.filter((task) => task.id.startsWith(needle));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0)
    throw new Error(`unknown scheduled task: ${needle}`);
  throw new Error(`ambiguous scheduled task prefix: ${needle}`);
}

function isLoopTask(task: ScheduledTaskShape): boolean {
  return task.mode === "loopFixed" || task.mode === "loopSelfPaced";
}

function isBulkManageTarget(
  task: ScheduledTaskShape,
  action: Exclude<ManageScheduledTasksParamsT["action"], "list">,
): boolean {
  if (!isLoopTask(task)) return false;
  if (task.status === "running") return false;
  if (action === "delete") return true;
  return !isTerminalStatus(task.status);
}

function isTerminalStatus(status: string | undefined): boolean {
  return (
    status === "cancelled" || status === "completed" || status === "expired"
  );
}

function summarizeTasks(tasks: ScheduledTaskShape[]): string {
  if (tasks.length === 0) return "no scheduled tasks";
  return tasks.map(taskTitle).join("\n");
}

function taskTitle(task: ScheduledTaskShape): string {
  const status = task.status ? ` (${task.status})` : "";
  const mode = task.mode ? ` ${task.mode}` : "";
  const label = task.label ? ` ${task.label}` : "";
  return `${task.id.slice(0, 8)}${mode}${status}${label}`.trim();
}
