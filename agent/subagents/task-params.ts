import { Type, type Static } from "typebox";
import { parseFileReferences } from "../file-references";
import type { Subagent } from "./types";

/** Cap on the text returned to the parent (and streamed partials). */
export const MAX_RESULT_CHARS = 100_000;

export type RequestedTaskSurface = "inline" | "background" | "auto";
export type ExecutionSurface = "inline" | "tab" | "background";

export interface SubagentTaskDeps {
  send: (obj: Record<string, unknown>) => void;
}

export interface SubagentRunDetails {
  subagent: string;
  model: string;
  surface: ExecutionSurface;
}

export type TextBlock = { type: "text"; text: string };
export type SubagentToolResult = {
  content: TextBlock[];
  details: SubagentRunDetails;
};
export type SubagentPartial = {
  content: TextBlock[];
  details?: SubagentRunDetails;
};
export type UpdateFn = (partial: SubagentPartial) => void;

export const TaskParams = Type.Object({
  subagent_type: Type.String({
    description:
      "Name of the subagent to delegate to. Must match one of the available subagents listed in the system prompt.",
  }),
  prompt: Type.String({
    description:
      "The full, self-contained task for the subagent. It runs in a fresh isolated session and only sees this text — include all context it needs. @file references are resolved relative to the parent tab's cwd and expanded before delegation.",
  }),
  context: Type.Optional(
    Type.String({
      description:
        "Optional extra context (file paths, constraints) prepended to the task. @file references are resolved like prompt references.",
    }),
  ),
  surface: Type.Optional(
    Type.Union([
      Type.Literal("inline"),
      Type.Literal("background"),
      Type.Literal("auto"),
    ], {
      description:
        "Where to run this delegation. `auto` (default for `task`) preserves the subagent's configured surface; `inline` waits for the result in this tool call; `background` launches a non-focused tab and returns immediately.",
    }),
  ),
});
export type TaskParamsT = Static<typeof TaskParams>;

export const BatchTaskItemParams = Type.Object({
  subagent_type: Type.String({
    description:
      "Name of the subagent to delegate to. Must match one of the available subagents listed in the system prompt.",
  }),
  prompt: Type.String({
    description:
      "The full, self-contained task for this subagent. It runs in a fresh isolated session and only sees this text — include all context it needs.",
  }),
  context: Type.Optional(
    Type.String({
      description:
        "Optional extra context (file paths, constraints) prepended to this task.",
    }),
  ),
});

export const BatchTaskParams = Type.Object({
  tasks: Type.Array(BatchTaskItemParams, {
    minItems: 1,
    description:
      "Ordered independent subagent delegations. Results are returned in this same order even when subagents finish out of order.",
  }),
  surface: Type.Optional(
    Type.Union([
      Type.Literal("inline"),
      Type.Literal("background"),
      Type.Literal("auto"),
    ], {
      description:
        "`inline` (default) runs all delegates concurrently and waits for partial results; `background` launches non-focused tabs; `auto` uses each subagent's configured surface.",
    }),
  ),
});
export type BatchTaskParamsT = Static<typeof BatchTaskParams>;

/** The delegated task body: an optional context block followed by the prompt.
 *  Kept separate from the subagent preamble so `@file` expansion runs over the
 *  user-provided text only (the subagent's own system prompt is excluded,
 *  matching prior behavior). */
export function composeTaskBody(params: TaskParamsT): string {
  const extra = params.context?.trim() ? `${params.context.trim()}\n\n` : "";
  return `${extra}${params.prompt}`;
}

/** Prepend the subagent's instructions to the (already `@file`-expanded) task
 *  body to form the single self-contained prompt. */
export function composePrompt(sub: Subagent, body: string): string {
  const preamble = sub.systemPrompt.trim()
    ? `${sub.systemPrompt.trim()}\n\n---\n`
    : "";
  return `${preamble}Task:\n${body}`;
}

export function hasTaskFileReferences(params: TaskParamsT): boolean {
  return (
    parseFileReferences(params.prompt).length > 0 ||
    (params.context ? parseFileReferences(params.context).length > 0 : false)
  );
}

export function resolveExecutionSurface(
  sub: Subagent,
  requested: RequestedTaskSurface,
): ExecutionSurface {
  if (requested === "inline") return "inline";
  if (requested === "background") return "background";
  return sub.surface === "tab" ? "tab" : "inline";
}

export function backgroundTabLabel(sub: Subagent, prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const summary =
    firstLine.length > 36 ? `${firstLine.slice(0, 35)}...` : firstLine;
  return summary ? `${sub.name}: ${summary}` : sub.name;
}
