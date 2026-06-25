import type { AethonAgentState } from "../state";
import { expandFileReferencesInPrompt } from "../file-references";
import { getSubagentsForCwd } from "./loader";
import { launchSubagentTab } from "./background-launcher";
import { runInlineSubagent } from "./inline-runner";
import {
  backgroundTabLabel,
  composePrompt,
  composeTaskBody,
  hasTaskFileReferences,
  resolveExecutionSurface,
  type RequestedTaskSurface,
  type SubagentTaskDeps,
  type SubagentToolResult,
  type TaskParamsT,
  type UpdateFn,
} from "./task-params";
import type { BatchProgressMeta } from "./progress-events";

export async function runSubagentTask(
  state: AethonAgentState,
  deps: SubagentTaskDeps,
  parentTabId: string,
  callId: string,
  params: TaskParamsT,
  signal: AbortSignal | undefined,
  onUpdate: UpdateFn | undefined,
  options: {
    defaultSurface?: RequestedTaskSurface;
    progress?: BatchProgressMeta;
  } = {},
): Promise<SubagentToolResult> {
  const cwd =
    state.tabProjectCwds.get(parentTabId) ??
    state.currentProjectCwd ??
    process.cwd();
  const name = params.subagent_type.trim().toLowerCase();
  // Resolve against the *parent tab's* cwd, not a global registry, so a tab on
  // project A always delegates to project A's subagents.
  const registry = getSubagentsForCwd(state, cwd);
  const sub = registry.byName.get(name);
  if (!sub) {
    const available =
      [...registry.byName.keys()].join(", ") || "(none configured)";
    throw new Error(
      `unknown subagent "${params.subagent_type}". Available subagents: ${available}.`,
    );
  }
  const taskBody = composeTaskBody(params);
  // Expand @file refs over the combined prompt + context in a single pass so a
  // file referenced in both dedupes into one <aethon_file_references> block and
  // the total-byte cap applies once. Skip the await entirely when there are no
  // refs so non-expanding delegations keep their original microtask timing.
  const expandedBody = hasTaskFileReferences(params)
    ? (
        await expandFileReferencesInPrompt(taskBody, {
          cwd,
          subagentNames: registry.byName.keys(),
        })
      ).prompt
    : taskBody;
  const composedPrompt = composePrompt(sub, expandedBody);
  const surface = resolveExecutionSurface(
    sub,
    params.surface ?? options.defaultSurface ?? "auto",
  );
  if (surface === "tab" || surface === "background") {
    return launchSubagentTab(sub, cwd, composedPrompt, {
      activate: surface !== "background",
      surface,
      ...(surface === "background"
        ? { label: backgroundTabLabel(sub, params.prompt) }
        : {}),
    });
  }

  return runInlineSubagent(
    state,
    deps,
    parentTabId,
    callId,
    sub,
    cwd,
    composedPrompt,
    signal,
    onUpdate,
    options.progress,
  );
}
