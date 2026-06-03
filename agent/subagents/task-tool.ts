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
 * Two surfaces:
 *  - `inline` (default): the subagent runs here, streaming live progress into
 *    the outer tool card (via `onUpdate`) and a richer `subagent_progress`
 *    sidecar stream. Its summary becomes the tool result.
 *  - `tab`: the subagent is launched as its own agent tab via
 *    `aethon.tasks.start`; the tool result just confirms the launch.
 *
 * The subagent never receives the `task` tool itself, so it can't recurse.
 */

import {
  SessionManager,
  createAgentSession,
  createBashToolDefinition,
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
import { extractAgentEndError } from "../agent-errors";
import { summarizeToolArgs } from "../tool-card";
import { logger } from "../logger";
import { resolveSubagentTools } from "./parse";
import type { Subagent, SubagentSurface } from "./types";

/** Hard ceiling on a single delegation so a wedged subagent can't hang the
 *  parent turn indefinitely. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Cap on the text returned to the parent (and streamed partials). */
const MAX_RESULT_CHARS = 100_000;

export interface SubagentTaskDeps {
  send: (obj: Record<string, unknown>) => void;
}

interface SubagentRunDetails {
  subagent: string;
  model: string;
  surface: SubagentSurface;
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
      "The full, self-contained task for the subagent. It runs in a fresh isolated session and only sees this text — include all context it needs.",
  }),
  context: Type.Optional(
    Type.String({
      description:
        "Optional extra context (file paths, constraints) prepended to the task.",
    }),
  ),
});
type TaskParamsT = Static<typeof TaskParams>;

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

async function runSubagentTask(
  state: AethonAgentState,
  deps: SubagentTaskDeps,
  parentTabId: string,
  callId: string,
  params: TaskParamsT,
  signal: AbortSignal | undefined,
  onUpdate: UpdateFn | undefined,
): Promise<SubagentToolResult> {
  const name = params.subagent_type.trim().toLowerCase();
  const sub = state.subagents.get(name);
  if (!sub) {
    const available =
      [...state.subagents.keys()].join(", ") || "(none configured)";
    throw new Error(
      `unknown subagent "${params.subagent_type}". Available subagents: ${available}.`,
    );
  }
  const cwd =
    state.tabProjectCwds.get(parentTabId) ??
    state.currentProjectCwd ??
    process.cwd();
  const composedPrompt = composePrompt(sub, params);

  if (sub.surface === "tab") {
    return launchSubagentTab(sub, cwd, composedPrompt);
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
  );
}

/** Compose the subagent's instructions (its markdown body) with the delegated
 *  task into a single self-contained prompt. */
function composePrompt(sub: Subagent, params: TaskParamsT): string {
  const extra = params.context?.trim() ? `${params.context.trim()}\n\n` : "";
  const preamble = sub.systemPrompt.trim()
    ? `${sub.systemPrompt.trim()}\n\n---\n`
    : "";
  return `${preamble}Task:\n${extra}${params.prompt}`;
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
  const devshellBashTool = createBashToolDefinition(cwd, {
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
          finalText += delta;
          onUpdate?.({
            content: [
              { type: "text", text: finalText.slice(-MAX_RESULT_CHARS) },
            ],
            details,
          });
          emitProgress(deps, parentTabId, callId, details, {
            phase: "text",
            delta,
          });
        },
        onThinking: (delta) =>
          emitProgress(deps, parentTabId, callId, details, {
            phase: "thinking",
            delta,
          }),
        onToolStart: (toolName, toolSummary) =>
          emitProgress(deps, parentTabId, callId, details, {
            phase: "tool_start",
            toolName,
            toolSummary,
          }),
        onToolEnd: (toolName, isError) =>
          emitProgress(deps, parentTabId, callId, details, {
            phase: "tool_end",
            toolName,
            isError,
          }),
        onEnd: (messages) => {
          errorMessage = extractAgentEndError(messages);
          if (!finalText.trim()) finalText = extractLastAssistantText(messages);
        },
      });
    },
  );

  const onAbort = (): void => {
    void session.abort();
  };
  signal?.addEventListener("abort", onAbort);

  emitProgress(deps, parentTabId, callId, details, { phase: "start" });
  try {
    await withTimeout(
      session.prompt(composedPrompt),
      DEFAULT_TIMEOUT_MS,
      () => {
        void session.abort();
      },
    );
  } catch (err) {
    emitProgress(deps, parentTabId, callId, details, {
      phase: "error",
      error: (err as Error).message,
    });
    throw new Error(
      `subagent "${sub.name}" failed: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
    });
    throw new Error(`subagent "${sub.name}" error: ${errorMessage}`);
  }

  emitProgress(deps, parentTabId, callId, details, { phase: "done" });
  const text = finalText.trim() || "(subagent produced no text output)";
  return {
    content: [{ type: "text", text: text.slice(0, MAX_RESULT_CHARS) }],
    details,
  };
}

interface TasksApi {
  start(args: {
    projectPath: string;
    prompt: string;
    model?: string;
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
): Promise<SubagentToolResult> {
  const api = getTasksApi();
  if (!api)
    throw new Error(
      "subagent tab launch unavailable (aethon.tasks API missing)",
    );
  const result = await api.start({
    projectPath: cwd,
    prompt: composedPrompt,
    ...(sub.model ? { model: sub.model } : {}),
  });
  if (!result.ok) {
    throw new Error(
      `subagent "${sub.name}" tab launch failed: ${result.error ?? "unknown"}`,
    );
  }
  const details: SubagentRunDetails = {
    subagent: sub.name,
    model: sub.model ?? "inherited",
    surface: "tab",
  };
  return {
    content: [
      { type: "text", text: `Launched subagent \`${sub.name}\` in a new tab.` },
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

function emitProgress(
  deps: SubagentTaskDeps,
  parentTabId: string,
  callId: string,
  details: SubagentRunDetails,
  info: ProgressInfo,
): void {
  deps.send({
    type: "subagent_progress",
    tabId: parentTabId,
    parentCallId: callId,
    subagent: details.subagent,
    model: details.model,
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
