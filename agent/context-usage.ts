import type { AethonAgentState, TabRecord } from "./state";
import {
  applyCachedOllamaContextWindow,
  refreshOllamaContextWindow,
} from "./ollama-context";
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
  /** The model's own authoritative usage has reached/exceeded the context
   *  window. For Ollama this means the server is silently truncating the
   *  oldest turns and re-reporting the cap — a frozen "100%" that hides
   *  data loss, distinct from a healthy near-full window. */
  saturated?: boolean;
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

export function clearPendingContextUsageEmit(rec: TabRecord): void {
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
  // For Ollama-backed models the configured window is often a guess; if we've
  // already probed the server's real window, write it onto the live model so
  // pi's getContextUsage()/shouldCompact() below measure against the truth.
  applyCachedOllamaContextWindow(rec.session.model);
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
  // The model's own authoritative count reached the window (Ollama pegs
  // prompt_tokens at num_ctx and truncates). Key off baseTokens, not the
  // transient-augmented/clamped tokens, so we only flag a real model report.
  const saturated = baseTokens !== null && baseTokens >= contextWindow;
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
    ...(saturated ? { saturated: true } : {}),
  };
}

export function emitContextUsage(
  state: AethonAgentState,
  deps: { send: (obj: Record<string, unknown>) => void },
  tabId: string,
  rec: TabRecord,
  options: { compacting?: boolean } = {},
): void {
  clearPendingContextUsageEmit(rec);
  rec.contextUsageLastEmitMs = Date.now();
  const snapshot = contextUsageSnapshot(state, tabId, rec, options);
  if (!snapshot) return;
  deps.send({ type: "context_usage", ...snapshot });
  // Best-effort: probe the Ollama server's real window in the background. If it
  // differs from the configured value, the model object is corrected and we
  // re-emit with the truth. No-op (and no re-emit) for non-Ollama models or when
  // the configured window already matches.
  void refreshOllamaContextWindow(rec.session.model).then((changed) => {
    if (changed) emitContextUsage(state, deps, tabId, rec, options);
  });
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
