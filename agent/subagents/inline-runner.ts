import {
  SessionManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "../state";
import {
  authProfileServicesForTab,
  servicesForProvider,
} from "../auth-profiles";
import { buildDevshellSpawnHook } from "../devshell";
import { createAethonBashToolDefinition } from "../bash-tool";
import { extractAgentEndError } from "../agent-errors";
import { logger } from "../logger";
import { resolveSubagentTools } from "./parse";
import type { Subagent } from "./types";
import { timeoutMsFromSeconds } from "../runtime-config";
import {
  MAX_RESULT_CHARS,
  type SubagentRunDetails,
  type SubagentTaskDeps,
  type SubagentToolResult,
  type UpdateFn,
} from "./task-params";
import {
  emitProgress,
  extractLastAssistantText,
  handleSubagentEvent,
  type BatchProgressMeta,
} from "./progress-events";
import { waitForAbortCleanup, withTimeout } from "./timeout";

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

export async function runInlineSubagent(
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
