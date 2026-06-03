import type { AethonAgentState } from "./state";

export const DEFAULT_AGENT_TIMEOUT_SECONDS = 300;
export const MAX_AGENT_TIMEOUT_SECONDS = 24 * 60 * 60;

export interface AethonRuntimeConfig {
  providerTimeoutMs?: number;
  bashTimeoutFloorSeconds: number;
  subagentTimeoutSeconds: number;
}

export function runtimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AethonRuntimeConfig {
  return {
    providerTimeoutMs: optionalSecondsToMs(
      env.AETHON_PROVIDER_TIMEOUT_SECONDS,
    ),
    bashTimeoutFloorSeconds: normalizeTimeoutSeconds(
      env.AETHON_BASH_TIMEOUT_FLOOR_SECONDS,
    ),
    subagentTimeoutSeconds: normalizeTimeoutSeconds(
      env.AETHON_SUBAGENT_TIMEOUT_SECONDS,
    ),
  };
}

export function runtimeConfigFromConfig(config: unknown): AethonRuntimeConfig {
  if (!isRecord(config)) {
    return {
      providerTimeoutMs: undefined,
      bashTimeoutFloorSeconds: DEFAULT_AGENT_TIMEOUT_SECONDS,
      subagentTimeoutSeconds: DEFAULT_AGENT_TIMEOUT_SECONDS,
    };
  }
  const agent = isRecord(config.agent) ? config.agent : {};
  return {
    providerTimeoutMs: optionalSecondsToMs(agent.providerTimeoutSeconds),
    bashTimeoutFloorSeconds: normalizeTimeoutSeconds(
      agent.bashTimeoutFloorSeconds,
    ),
    subagentTimeoutSeconds: normalizeTimeoutSeconds(
      agent.subagentTimeoutSeconds,
    ),
  };
}

export function applyRuntimeConfig(
  state: AethonAgentState,
  config: AethonRuntimeConfig,
): void {
  state.providerTimeoutMs = config.providerTimeoutMs;
  state.bashTimeoutFloorSeconds = config.bashTimeoutFloorSeconds;
  state.subagentTimeoutSeconds = config.subagentTimeoutSeconds;
}

const providerRetryBases = new WeakMap<object, Record<string, unknown>>();

export function applyProviderTimeoutOverride(state: AethonAgentState): void {
  const manager = state.settingsManager as {
    applyOverrides?: (overrides: Record<string, unknown>) => void;
    getProviderRetrySettings?: () => Record<string, unknown>;
  };
  if (
    typeof manager.applyOverrides !== "function" ||
    typeof manager.getProviderRetrySettings !== "function"
  ) {
    return;
  }
  let base = providerRetryBases.get(manager);
  if (!base) {
    base = manager.getProviderRetrySettings();
    providerRetryBases.set(manager, base);
  }
  const provider =
    state.providerTimeoutMs === undefined
      ? base
      : { ...base, timeoutMs: state.providerTimeoutMs };
  manager.applyOverrides({ retry: { provider } });
}

export function applyBashTimeoutFloor<T extends Record<string, unknown>>(
  args: T,
  floorSeconds: number,
): T {
  const current = args.timeout;
  if (typeof current !== "number" || !Number.isFinite(current)) return args;
  const floor = normalizeTimeoutSeconds(floorSeconds);
  if (current >= floor) return args;
  return { ...args, timeout: floor };
}

export function timeoutMsFromSeconds(seconds: number): number {
  return normalizeTimeoutSeconds(seconds) * 1000;
}

function normalizeTimeoutSeconds(value: unknown): number {
  if (typeof value === "string" && value.trim()) {
    return normalizeTimeoutSeconds(Number(value));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_AGENT_TIMEOUT_SECONDS;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_AGENT_TIMEOUT_SECONDS);
}

function optionalSecondsToMs(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "string" && value.trim()) {
    return optionalSecondsToMs(Number(value));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return (
    Math.min(Math.max(Math.floor(value), 1), MAX_AGENT_TIMEOUT_SECONDS) * 1000
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
