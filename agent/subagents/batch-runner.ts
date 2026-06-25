import type { AethonAgentState } from "../state";
import { runSubagentTask } from "./task-runner";
import {
  MAX_RESULT_CHARS,
  type BatchTaskParamsT,
  type SubagentTaskDeps,
  type SubagentToolResult,
  type UpdateFn,
} from "./task-params";

export async function runSubagentTaskBatch(
  state: AethonAgentState,
  deps: SubagentTaskDeps,
  parentTabId: string,
  callId: string,
  params: BatchTaskParamsT,
  signal: AbortSignal | undefined,
  onUpdate: UpdateFn | undefined,
): Promise<SubagentToolResult> {
  if (params.tasks.length === 0) {
    throw new Error("task_batch requires at least one task");
  }
  const surface = params.surface ?? "inline";
  const partials = new Map<number, string>();
  const emitBatchUpdate = (): void => {
    if (!onUpdate) return;
    const text = params.tasks
      .map((task, index) => {
        const partial = partials.get(index);
        if (!partial) return "";
        return `## ${task.subagent_type}\n${partial}`;
      })
      .filter(Boolean)
      .join("\n\n");
    if (!text) return;
    onUpdate({
      content: [{ type: "text", text: text.slice(-MAX_RESULT_CHARS) }],
      details: {
        subagent: "batch",
        model: "mixed",
        surface: surface === "background" ? "background" : "inline",
      },
    });
  };

  const jobs = params.tasks.map((task, index) =>
    runSubagentTask(
      state,
      deps,
      parentTabId,
      callId,
      { ...task, surface },
      signal,
      (partial) => {
        const text = partial.content
          .map((block) => block.text)
          .join("\n")
          .trim();
        if (text) {
          partials.set(index, text);
          emitBatchUpdate();
        }
      },
      {
        defaultSurface: surface,
        progress: {
          batchItemId: `${index}:${task.subagent_type.trim().toLowerCase()}`,
          batchIndex: index,
        },
      },
    ),
  );

  const settled = await Promise.allSettled(jobs);
  const failures = settled.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length === settled.length) {
    const messages = failures
      .map((failure) =>
        failure.reason instanceof Error
          ? failure.reason.message
          : String(failure.reason),
      )
      .join("; ");
    throw new Error(`all subagents failed: ${messages}`);
  }

  const sections = settled.map((result, index) => {
    const name = params.tasks[index]?.subagent_type ?? `task ${index + 1}`;
    if (result.status === "fulfilled") {
      const text =
        result.value.content.map((block) => block.text).join("\n").trim() ||
        "(subagent produced no text output)";
      return `## ${name}\n${text}`;
    }
    const message =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    return `## ${name}\nFailed: ${message}`;
  });

  return {
    content: [{ type: "text", text: sections.join("\n\n") }],
    details: {
      subagent: "batch",
      model: "mixed",
      surface: surface === "background" ? "background" : "inline",
    },
  };
}
