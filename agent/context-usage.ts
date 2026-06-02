import type { AethonAgentState, TabRecord } from "./state";
import { modelKey } from "./tab-lifecycle/utils";

const LIVE_CONTEXT_EMIT_INTERVAL_MS = 250;

export interface ContextUsageSnapshot {
  tabId: string;
  model: string;
  status: "known" | "unknown";
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  autoCompactEnabled: boolean;
  reserveTokens: number;
  compactAtTokens: number;
  tokensUntilCompact: number | null;
  compacting?: boolean;
}

interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function clearPendingEmit(rec: TabRecord): void {
  if (rec.contextUsageEmitTimer !== undefined) {
    clearTimeout(rec.contextUsageEmitTimer);
    rec.contextUsageEmitTimer = undefined;
  }
}

export function clearLiveContextUsageEstimate(rec: TabRecord): void {
  rec.contextUsageTransientTokens = 0;
}

export function addLiveContextUsageEstimate(
  rec: TabRecord,
  text: string,
): void {
  const estimated = estimateTokens(text);
  if (estimated <= 0) return;
  rec.contextUsageTransientTokens =
    (rec.contextUsageTransientTokens ?? 0) + estimated;
}

export function contextUsageSnapshot(
  state: AethonAgentState,
  tabId: string,
  rec: TabRecord,
  options: { compacting?: boolean } = {},
): ContextUsageSnapshot | undefined {
  const usage = (
    rec.session as { getContextUsage?: () => PiContextUsage | undefined }
  ).getContextUsage?.();
  const modelContextWindow = finiteNumber(rec.session.model?.contextWindow);
  const contextWindow =
    finiteNumber(usage?.contextWindow) ?? modelContextWindow ?? 0;
  if (contextWindow <= 0) return undefined;

  const settings = state.settingsManager.getCompactionSettings();
  const reserveTokens = Math.max(0, settings.reserveTokens);
  const compactAtTokens = Math.max(contextWindow - reserveTokens, 0);
  const baseTokens = finiteNumber(usage?.tokens) ?? null;
  const transientTokens = Math.max(0, rec.contextUsageTransientTokens ?? 0);
  const tokens =
    baseTokens === null ? null : Math.min(baseTokens + transientTokens, contextWindow);
  const percent =
    (tokens !== baseTokens && tokens !== null
      ? (tokens / contextWindow) * 100
      : finiteNumber(usage?.percent)) ??
    (tokens !== null && contextWindow > 0
      ? (tokens / contextWindow) * 100
      : null);

  return {
    tabId,
    model: rec.session.model ? modelKey(rec.session.model) : "",
    status: tokens === null || percent === null ? "unknown" : "known",
    tokens,
    contextWindow,
    percent,
    autoCompactEnabled: settings.enabled,
    reserveTokens,
    compactAtTokens,
    tokensUntilCompact:
      tokens === null ? null : Math.max(compactAtTokens - tokens, 0),
    ...(options.compacting ? { compacting: true } : {}),
  };
}

export function emitContextUsage(
  state: AethonAgentState,
  deps: { send: (obj: Record<string, unknown>) => void },
  tabId: string,
  rec: TabRecord,
  options: { compacting?: boolean } = {},
): void {
  clearPendingEmit(rec);
  rec.contextUsageLastEmitMs = Date.now();
  const snapshot = contextUsageSnapshot(state, tabId, rec, options);
  if (!snapshot) return;
  deps.send({ type: "context_usage", ...snapshot });
}

export function emitContextUsageThrottled(
  state: AethonAgentState,
  deps: { send: (obj: Record<string, unknown>) => void },
  tabId: string,
  rec: TabRecord,
): void {
  const now = Date.now();
  const last = rec.contextUsageLastEmitMs ?? 0;
  const remaining = LIVE_CONTEXT_EMIT_INTERVAL_MS - (now - last);
  if (remaining <= 0) {
    emitContextUsage(state, deps, tabId, rec);
    return;
  }
  if (rec.contextUsageEmitTimer !== undefined) return;
  rec.contextUsageEmitTimer = setTimeout(() => {
    rec.contextUsageEmitTimer = undefined;
    emitContextUsage(state, deps, tabId, rec);
  }, remaining);
}
