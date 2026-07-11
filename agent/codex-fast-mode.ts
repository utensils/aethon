import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "./state";
import { modelSupportsPriorityServiceTier } from "./model-capabilities";

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
    return applyCodexFastModeToPayload(
      next,
      state.codexFastMode,
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
