import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "./state";
import { modelSupportsPriorityServiceTier } from "./model-capabilities";
import type { CodexExtendedReasoningEffort } from "./codex-reasoning";

const patchedAgents = new WeakSet<object>();

type ProviderPayload = Record<string, unknown>;

type AgentLike = {
  onPayload?: (
    payload: unknown,
    model?: Model<Api>,
  ) => unknown | Promise<unknown>;
  streamFn?: (
    model: Model<Api>,
    context: unknown,
    options?: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
};

export function supportsCodexFastMode(model: Model<Api> | undefined): boolean {
  return modelSupportsPriorityServiceTier(model);
}

export function applyCodexFastModeToPayload(
  payload: unknown,
  enabled: boolean,
  model: Model<Api> | undefined,
): unknown {
  if (!enabled || !supportsCodexFastMode(model) || !isRecord(payload)) {
    return payload;
  }
  return { ...payload, service_tier: "priority" } satisfies ProviderPayload;
}

export function applyCodexModeToPayload(
  payload: unknown,
  fastModeEnabled: boolean,
  extendedEffort: CodexExtendedReasoningEffort | undefined,
  model: Model<Api> | undefined,
): unknown {
  let next = applyCodexFastModeToPayload(payload, fastModeEnabled, model);
  if (
    !extendedEffort ||
    model?.provider !== "openai-codex" ||
    !/^gpt-5\.6-(?:sol|terra|luna)$/.test(model.id) ||
    !isRecord(next)
  ) {
    return next;
  }
  const currentReasoning = isRecord(next.reasoning) ? next.reasoning : {};
  next = {
    ...next,
    reasoning: { ...currentReasoning, effort: extendedEffort },
  };
  return next;
}

/**
 * Pi exposes request-body mutation through Agent.onPayload, while Codex usage
 * accounting reads the requested service tier from stream options. Patch both
 * stable Agent hooks so Fast mode survives extension/session reloads that swap
 * extension runners under the same AgentSession.
 */
export function installCodexFastModePayloadHook(
  state: AethonAgentState,
  session: {
    model?: Model<Api>;
    agent?: AgentLike;
  },
): void {
  const agent = session.agent;
  if (!agent || patchedAgents.has(agent)) return;
  const originalOnPayload = agent.onPayload?.bind(agent);
  const originalStreamFn = agent.streamFn?.bind(agent);

  patchedAgents.add(agent);

  agent.onPayload = async (payload: unknown, model?: Model<Api>) => {
    const next = originalOnPayload
      ? await originalOnPayload(payload, model)
      : payload;
    let effort: CodexExtendedReasoningEffort | undefined;
    for (const tab of state.tabs?.values() ?? []) {
      if (tab.session === session) {
        effort = tab.codexExtendedReasoningEffort;
        break;
      }
    }
    return applyCodexModeToPayload(
      next,
      state.codexFastMode,
      effort,
      model ?? session.model,
    );
  };

  if (originalStreamFn) {
    agent.streamFn = (
      model: Model<Api>,
      context: unknown,
      options?: Record<string, unknown>,
    ) => {
      const nextOptions =
        state.codexFastMode && supportsCodexFastMode(model)
          ? { ...(options ?? {}), serviceTier: "priority" }
          : options;
      return originalStreamFn(model, context, nextOptions);
    };
  }
}

function isRecord(value: unknown): value is ProviderPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
