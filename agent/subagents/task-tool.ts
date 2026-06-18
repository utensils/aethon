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

import {
  SessionManager,
  createAgentSession,
  defineTool,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { Type, type Static } from "typebox";
import type { AethonAgentState } from "../state";
import {
  authProfileServicesForTab,
  servicesForProvider,
} from "../auth-profiles";
import { buildDevshellSpawnHook } from "../devshell";
import { createAethonBashToolDefinition } from "../bash-tool";
import { extractAgentEndError } from "../agent-errors";
import { summarizeToolArgs } from "../tool-card";
import { logger } from "../logger";
import { getSubagentsForCwd } from "./loader";
import { resolveSubagentTools } from "./parse";
import type { Subagent } from "./types";
import { timeoutMsFromSeconds } from "../runtime-config";
import {
  expandFileReferencesInPrompt,
  parseFileReferences,
  stripExpandedFileReferences,
} from "../file-references";
/** Cap on the text returned to the parent (and streamed partials). */
const MAX_RESULT_CHARS = 100_000;
const ABORT_CLEANUP_GRACE_MS = 2_000;
type RequestedTaskSurface = "inline" | "background" | "auto";
type ExecutionSurface = "inline" | "tab" | "background";

export interface SubagentTaskDeps {
  send: (obj: Record<string, unknown>) => void;
}

interface SubagentRunDetails {
  subagent: string;
  model: string;
  surface: ExecutionSurface;
}

type TextBlock = { type: "text"; text: string };
type SubagentToolResult = { content: TextBlock[]; details: SubagentRunDetails };
type SubagentPartial = { content: TextBlock[]; details?: SubagentRunDetails };
type UpdateFn = (partial: SubagentPartial) => void;

const TaskParams = Type.Object({
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
type TaskParamsT = Static<typeof TaskParams>;

const BatchTaskItemParams = Type.Object({
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

const BatchTaskParams = Type.Object({
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
type BatchTaskParamsT = Static<typeof BatchTaskParams>;

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

async function runSubagentTask(
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

function resolveExecutionSurface(
  sub: Subagent,
  requested: RequestedTaskSurface,
): ExecutionSurface {
  if (requested === "inline") return "inline";
  if (requested === "background") return "background";
  return sub.surface === "tab" ? "tab" : "inline";
}

function backgroundTabLabel(sub: Subagent, prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const summary =
    firstLine.length > 36 ? `${firstLine.slice(0, 35)}...` : firstLine;
  return summary ? `${sub.name}: ${summary}` : sub.name;
}

async function runSubagentTaskBatch(
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

/** The delegated task body: an optional context block followed by the prompt.
 *  Kept separate from the subagent preamble so `@file` expansion runs over the
 *  user-provided text only (the subagent's own system prompt is excluded,
 *  matching prior behavior). */
function composeTaskBody(params: TaskParamsT): string {
  const extra = params.context?.trim() ? `${params.context.trim()}\n\n` : "";
  return `${extra}${params.prompt}`;
}

/** Prepend the subagent's instructions to the (already `@file`-expanded) task
 *  body to form the single self-contained prompt. */
function composePrompt(sub: Subagent, body: string): string {
  const preamble = sub.systemPrompt.trim()
    ? `${sub.systemPrompt.trim()}\n\n---\n`
    : "";
  return `${preamble}Task:\n${body}`;
}

function hasTaskFileReferences(params: TaskParamsT): boolean {
  return (
    parseFileReferences(params.prompt).length > 0 ||
    (params.context ? parseFileReferences(params.context).length > 0 : false)
  );
}

interface ResolvedModelServices {
  model: Model<Api> | undefined;
  authStorage: ReturnType<typeof servicesForProvider>["authStorage"];
  modelRegistry: ReturnType<typeof servicesForProvider>["modelRegistry"];
}

/** Resolve the model AND its matching auth/model services together (see
 *  {@link servicesForProvider}). Returns null when an explicit model can't be
 *  found in its provider's registry. */
function resolveModelServices(
  state: AethonAgentState,
  parentTabId: string,
  modelId: string | undefined,
): ResolvedModelServices | null {
  if (modelId && modelId.trim()) {
    const [provider, ...rest] = modelId.split("/");
    const services = servicesForProvider(state, provider);
    const model = services.modelRegistry.find(provider, rest.join("/"));
    if (!model) return null;
    return {
      model,
      authStorage: services.authStorage,
      modelRegistry: services.modelRegistry,
    };
  }
  // No explicit model — inherit the parent tab's model + services.
  const parent = state.tabs.get(parentTabId);
  const services = authProfileServicesForTab(state, parentTabId);
  return {
    model: parent?.session.model ?? undefined,
    authStorage: services.authStorage,
    modelRegistry: services.modelRegistry,
  };
}

async function runInlineSubagent(
  state: AethonAgentState,
  deps: SubagentTaskDeps,
  parentTabId: string,
  callId: string,
  sub: Subagent,
  cwd: string,
  composedPrompt: string,
  signal: AbortSignal | undefined,
  onUpdate: UpdateFn | undefined,
  progress?: BatchProgressMeta,
): Promise<SubagentToolResult> {
  const resolved = resolveModelServices(state, parentTabId, sub.model);
  if (!resolved) {
    throw new Error(
      `subagent "${sub.name}": model "${sub.model}" is not available — check that its provider is signed in.`,
    );
  }
  const { model, authStorage, modelRegistry } = resolved;
  const modelLabel = model
    ? `${model.provider}/${model.id}`
    : (sub.model ?? "inherited");
  const details: SubagentRunDetails = {
    subagent: sub.name,
    model: modelLabel,
    surface: "inline",
  };

  // Devshell-aware bash shadow so the subagent's bash (if allowlisted) inherits
  // the project's Nix env, exactly like the main agent's.
  const devshellBashTool = createAethonBashToolDefinition(state, cwd, {
    spawnHook: buildDevshellSpawnHook(state, deps),
  });

  const { session } = await createAgentSession({
    ...(model ? { model } : {}),
    authStorage,
    modelRegistry,
    settingsManager: state.settingsManager,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: state.resourceLoader,
    cwd,
    customTools: [devshellBashTool],
    ...resolveSubagentTools(sub),
  });

  let finalText = "";
  let errorMessage: string | undefined;

  const unsubscribe = session.subscribe(
    (event: { type: string } & Record<string, unknown>) => {
      handleSubagentEvent(event, {
        onText: (delta) => {
          // Keep only the trailing MAX_RESULT_CHARS so a verbose subagent can't
          // grow this buffer without bound (the result we return is the tail).
          finalText = (finalText + delta).slice(-MAX_RESULT_CHARS);
          onUpdate?.({
            content: [{ type: "text", text: finalText }],
            details,
          });
          emitProgress(deps, parentTabId, callId, details, {
            phase: "text",
            delta,
          }, progress);
        },
        onThinking: (delta) =>
          emitProgress(deps, parentTabId, callId, details, {
            phase: "thinking",
            delta,
          }, progress),
        onToolStart: (toolName, toolSummary) =>
          emitProgress(deps, parentTabId, callId, details, {
            phase: "tool_start",
            toolName,
            toolSummary,
          }, progress),
        onToolEnd: (toolName, isError) =>
          emitProgress(deps, parentTabId, callId, details, {
            phase: "tool_end",
            toolName,
            isError,
          }, progress),
        onEnd: (messages) => {
          errorMessage = extractAgentEndError(messages);
          if (!finalText.trim()) {
            finalText =
              extractLastAssistantText(messages).slice(-MAX_RESULT_CHARS);
          }
        },
      });
    },
  );

  let abortPromise: Promise<void> | undefined;
  const requestAbort = (): Promise<void> => {
    abortPromise ??= session.abort().catch((err: unknown) => {
      logger
        .scope("subagent")
        .warn(
          `abort failed for "${sub.name}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
    });
    return abortPromise;
  };
  const onAbort = (): void => {
    void requestAbort();
  };
  signal?.addEventListener("abort", onAbort);

  emitProgress(deps, parentTabId, callId, details, { phase: "start" }, progress);
  try {
    await withTimeout(
      session.prompt(composedPrompt),
      timeoutMsFromSeconds(sub.timeoutSeconds ?? state.subagentTimeoutSeconds),
      () => {
        void requestAbort();
      },
    );
  } catch (err) {
    emitProgress(deps, parentTabId, callId, details, {
      phase: "error",
      error: (err as Error).message,
    }, progress);
    throw new Error(
      `subagent "${sub.name}" failed: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (abortPromise) {
      await waitForAbortCleanup(abortPromise, sub.name);
    }
    unsubscribe();
    try {
      session.dispose();
    } catch (err) {
      logger
        .scope("subagent")
        .warn(`dispose failed for "${sub.name}": ${(err as Error).message}`);
    }
  }

  if (errorMessage) {
    emitProgress(deps, parentTabId, callId, details, {
      phase: "error",
      error: errorMessage,
    }, progress);
    throw new Error(`subagent "${sub.name}" error: ${errorMessage}`);
  }

  emitProgress(deps, parentTabId, callId, details, { phase: "done" }, progress);
  const text = finalText.trim() || "(subagent produced no text output)";
  return {
    content: [{ type: "text", text: text.slice(0, MAX_RESULT_CHARS) }],
    details,
  };
}

async function waitForAbortCleanup(
  abortPromise: Promise<void>,
  subagentName: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(
      () => resolve("timeout"),
      ABORT_CLEANUP_GRACE_MS,
    );
  });
  const result = await Promise.race([
    abortPromise.then(() => "settled" as const),
    timeoutPromise,
  ]);
  if (timeout) clearTimeout(timeout);
  if (result === "timeout") {
    logger
      .scope("subagent")
      .warn(
        `abort did not settle within ${ABORT_CLEANUP_GRACE_MS}ms for "${subagentName}"; disposing session anyway`,
      );
  }
}

interface TasksApi {
  start(args: {
    projectPath: string;
    prompt: string;
    model?: string;
    bridgePrompt?: string;
    activate?: boolean;
    label?: string;
  }): Promise<{ ok: boolean; error?: string; data?: unknown }>;
}

function getTasksApi(): TasksApi | null {
  const g = globalThis as { aethon?: { tasks?: TasksApi } };
  return g.aethon?.tasks ?? null;
}

async function launchSubagentTab(
  sub: Subagent,
  cwd: string,
  composedPrompt: string,
  options: {
    activate: boolean;
    surface: "tab" | "background";
    label?: string;
  },
): Promise<SubagentToolResult> {
  const api = getTasksApi();
  if (!api)
    throw new Error(
      "subagent tab launch unavailable (aethon.tasks API missing)",
    );
  const displayPrompt = stripExpandedFileReferences(composedPrompt);
  const result = await api.start({
    projectPath: cwd,
    prompt: displayPrompt,
    ...(displayPrompt !== composedPrompt
      ? { bridgePrompt: composedPrompt }
      : {}),
    ...(sub.model ? { model: sub.model } : {}),
    ...(options.activate === false ? { activate: false } : {}),
    ...(options.label ? { label: options.label } : {}),
  });
  if (!result.ok) {
    throw new Error(
      `subagent "${sub.name}" tab launch failed: ${result.error ?? "unknown"}`,
    );
  }
  const details: SubagentRunDetails = {
    subagent: sub.name,
    model: sub.model ?? "inherited",
    surface: options.surface,
  };
  const surfaceText =
    options.surface === "background" ? "a background tab" : "a new tab";
  return {
    content: [
      {
        type: "text",
        text: `Launched subagent \`${sub.name}\` in ${surfaceText}.`,
      },
    ],
    details,
  };
}

interface SubagentEventCallbacks {
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  onToolStart: (toolName: string, toolSummary: string) => void;
  onToolEnd: (toolName: string, isError: boolean) => void;
  onEnd: (messages: unknown[]) => void;
}

/** Translate the subagent session's pi events into the streaming callbacks. */
function handleSubagentEvent(
  event: { type: string } & Record<string, unknown>,
  cb: SubagentEventCallbacks,
): void {
  switch (event.type) {
    case "message_update": {
      const ame = (
        event as { assistantMessageEvent?: { type?: string; delta?: string } }
      ).assistantMessageEvent;
      const delta = ame?.delta ?? "";
      if (!delta) break;
      if (ame?.type === "text_delta") cb.onText(delta);
      else if (
        ame?.type === "thinking_delta" ||
        ame?.type === "reasoning_delta"
      ) {
        cb.onThinking(delta);
      }
      break;
    }
    case "tool_execution_start": {
      const ev = event as { toolName?: string; args?: unknown };
      const toolName = ev.toolName ?? "tool";
      cb.onToolStart(toolName, summarizeToolArgs(toolName, ev.args));
      break;
    }
    case "tool_execution_end": {
      const ev = event as { toolName?: string; isError?: boolean };
      cb.onToolEnd(ev.toolName ?? "tool", ev.isError === true);
      break;
    }
    case "agent_end": {
      const ev = event as { messages?: unknown[] };
      cb.onEnd(ev.messages ?? []);
      break;
    }
  }
}

/** Pull the last assistant message's text out of an agent_end `messages` array
 *  (fallback when no text deltas were captured). */
function extractLastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message?.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) =>
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string"
            ? (block as { text: string }).text
            : "",
        )
        .join("");
      if (text) return text;
    }
  }
  return "";
}

interface ProgressInfo {
  phase:
    | "start"
    | "text"
    | "thinking"
    | "tool_start"
    | "tool_end"
    | "done"
    | "error";
  delta?: string;
  toolName?: string;
  toolSummary?: string;
  isError?: boolean;
  error?: string;
}

interface BatchProgressMeta {
  batchItemId: string;
  batchIndex: number;
}

function emitProgress(
  deps: SubagentTaskDeps,
  parentTabId: string,
  callId: string,
  details: SubagentRunDetails,
  info: ProgressInfo,
  batch?: BatchProgressMeta,
): void {
  deps.send({
    type: "subagent_progress",
    tabId: parentTabId,
    parentCallId: callId,
    subagent: details.subagent,
    model: details.model,
    ...(batch
      ? { batchItemId: batch.batchItemId, batchIndex: batch.batchIndex }
      : {}),
    ...info,
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
