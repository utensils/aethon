/**
 * The `task` delegation tool.
 *
 * Registered per agent tab (alongside the devshell bash shadow and the
 * dashboard/shell tools) so the main model can hand a focused task to a
 * configured subagent — chosen by `description` (auto-delegation) or named
 * explicitly via `@name`. Each delegation runs an **isolated** pi session
 * (`SessionManager.inMemory()`) with the subagent's own model + tool allowlist
 * and returns its final text to the caller as the tool result.
 *
 * Three requested surfaces:
 *  - `inline`: the subagent runs here, streaming live progress into
 *    the outer tool card (via `onUpdate`) and a richer `subagent_progress`
 *    sidecar stream. Its summary becomes the tool result.
 *  - `background`: the subagent is launched as its own non-focused agent tab
 *    via `aethon.tasks.start`; the tool result just confirms the launch.
 *  - `auto` (the `task` default): the subagent definition decides (`inline` or
 *    focused `tab`). `task_batch` defaults to inline fan-out.
 *
 * The subagent never receives the `task` tool itself, so it can't recurse.
 */

import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AethonAgentState } from "../state";
import { runSubagentTaskBatch } from "./batch-runner";
import { runSubagentTask } from "./task-runner";
import {
  BatchTaskParams,
  TaskParams,
  type BatchTaskParamsT,
  type SubagentTaskDeps,
  type SubagentToolResult,
  type TaskParamsT,
  type UpdateFn,
} from "./task-params";

export {
  BatchTaskItemParams,
  BatchTaskParams,
  TaskParams,
  type BatchTaskParamsT,
  type ExecutionSurface,
  type RequestedTaskSurface,
  type SubagentRunDetails,
  type SubagentTaskDeps,
  type SubagentToolResult,
  type TaskParamsT,
  type UpdateFn,
} from "./task-params";

/** Build the `task` tool bound to a specific parent tab. The captured
 *  `parentTabId` routes nested progress events and resolves the inherited
 *  model + cwd. */
export function buildSubagentTaskTool(
  state: AethonAgentState,
  deps: SubagentTaskDeps,
  parentTabId: string,
): ToolDefinition {
  return defineTool({
    name: "task",
    label: "Delegate to a subagent",
    description:
      "Delegate a focused task to a configured subagent. Pick the subagent whose description best matches the work; pass a complete, self-contained prompt. The subagent runs in an isolated session (its own model + tools) and returns a summary. Use this to offload narrow, well-scoped work (review, research, codegen) — especially to a cheaper/local model.",
    promptSnippet:
      "task: delegate a focused task to a configured subagent (see the subagents list)",
    parameters: TaskParams,
    async execute(
      callId: string,
      params: TaskParamsT,
      signal: AbortSignal | undefined,
      onUpdate: UpdateFn | undefined,
    ): Promise<SubagentToolResult> {
      return runSubagentTask(
        state,
        deps,
        parentTabId,
        callId,
        params,
        signal,
        onUpdate,
      );
    },
  }) as ToolDefinition;
}

export function buildSubagentTaskBatchTool(
  state: AethonAgentState,
  deps: SubagentTaskDeps,
  parentTabId: string,
): ToolDefinition {
  return defineTool({
    name: "task_batch",
    label: "Delegate to multiple subagents",
    description:
      "Delegate multiple independent tasks to configured subagents concurrently. Use this when the user explicitly names more than one subagent or when several subagents should peer-review/research/build in parallel. Inline mode waits for all delegates and returns one section per subagent; background mode launches non-focused tabs and returns immediately.",
    promptSnippet:
      "task_batch: fan out independent tasks to multiple configured subagents",
    parameters: BatchTaskParams,
    async execute(
      callId: string,
      params: BatchTaskParamsT,
      signal: AbortSignal | undefined,
      onUpdate: UpdateFn | undefined,
    ): Promise<SubagentToolResult> {
      return runSubagentTaskBatch(
        state,
        deps,
        parentTabId,
        callId,
        params,
        signal,
        onUpdate,
      );
    },
  }) as ToolDefinition;
}
