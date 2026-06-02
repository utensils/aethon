/**
 * Effective context-window resolution for Ollama-backed models.
 *
 * pi-ai's OpenAI-compatible path never sends `num_ctx`, so the real window an
 * Ollama server uses for a model is whatever its Modelfile / OLLAMA_CONTEXT_LENGTH
 * says — independent of the hand-typed `contextWindow` in ~/.pi/agent/models.json.
 * When those diverge the context meter (and pi's auto-compaction, which keys off
 * `model.contextWindow`) measure against the wrong yardstick.
 *
 * This module probes the live server for the model's actually-loaded window and
 * writes it back onto the live `Model` object so the meter and compaction both
 * use the truth. It is best-effort and non-blocking: a cold cache leaves the
 * configured value untouched while a background probe runs; the next emit picks
 * up the corrected value.
 *
 *   - /api/ps   (preferred) reflects the actually-loaded `num_ctx`.
 *   - /api/show (fallback)  reports the model's max — the server may run smaller.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { logger } from "./logger";

const log = logger.scope("ollama-ctx");

/** A resolved window is stable for the lifetime of a model load. */
const TTL_MS = 60_000;
/** Don't hammer an unreachable / non-Ollama host on every emit. */
const NEG_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_000;

interface CacheEntry {
  /** Resolved effective window; undefined means "probed but unknown". */
  window?: number;
  expiresAt: number;
  inflight?: Promise<number | undefined>;
}

const cache = new Map<string, CacheEntry>();

export function isOllamaModel(
  model: Model<Api> | undefined,
): model is Model<Api> {
  if (!model) return false;
  const provider = (model.provider ?? "").toLowerCase();
  const baseUrl = model.baseUrl ?? "";
  // ollama-* providers, or anything on Ollama's default port. Deliberately
  // excludes lmstudio (:1234) so we never probe /api/ps against it.
  return provider.includes("ollama") || baseUrl.includes(":11434");
}

/** Strip the trailing `/v1` (OpenAI-compat) to get the Ollama REST origin. */
function originFor(model: Model<Api>): string {
  return (model.baseUrl ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

function cacheKey(model: Model<Api>): string {
  return `${originFor(model)}|${model.id}`;
}

/** Synchronous read of a fresh cached effective window, if any. */
export function cachedOllamaContextWindow(
  model: Model<Api> | undefined,
): number | undefined {
  if (!isOllamaModel(model)) return undefined;
  const entry = cache.get(cacheKey(model));
  if (!entry || entry.expiresAt <= Date.now()) return undefined;
  return entry.window;
}

/**
 * Write a known effective window onto the live model object so pi's
 * getContextUsage()/shouldCompact() and the meter all measure against the
 * server's real window. Idempotent + synchronous. Returns true if it changed
 * the model.
 */
export function applyCachedOllamaContextWindow(
  model: Model<Api> | undefined,
): boolean {
  if (!isOllamaModel(model)) return false;
  const win = cachedOllamaContextWindow(model);
  if (win === undefined || win <= 0 || model.contextWindow === win) return false;
  log.debug(
    `correcting ${model.provider}/${model.id} contextWindow ${model.contextWindow} -> ${win}`,
  );
  model.contextWindow = win;
  return true;
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<unknown | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return undefined;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function probePs(
  origin: string,
  modelId: string,
): Promise<number | undefined> {
  const body = (await fetchJson(`${origin}/api/ps`)) as
    | {
        models?: Array<{
          name?: string;
          model?: string;
          context_length?: number;
        }>;
      }
    | undefined;
  const entry = body?.models?.find(
    (m) => m.name === modelId || m.model === modelId,
  );
  const win = entry?.context_length;
  return typeof win === "number" && win > 0 ? win : undefined;
}

async function probeShow(
  origin: string,
  modelId: string,
): Promise<number | undefined> {
  const body = (await fetchJson(`${origin}/api/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: modelId }),
  })) as { model_info?: Record<string, unknown> } | undefined;
  for (const [k, v] of Object.entries(body?.model_info ?? {})) {
    if (k.endsWith(".context_length") && typeof v === "number" && v > 0) {
      return v;
    }
  }
  return undefined;
}

/**
 * Resolve and cache the effective context window for an Ollama-backed model,
 * then write it onto the live model object. Best-effort: on any failure the
 * configured value is left untouched. Returns true if the model's contextWindow
 * was changed.
 */
export async function refreshOllamaContextWindow(
  model: Model<Api> | undefined,
): Promise<boolean> {
  if (!isOllamaModel(model)) return false;
  const key = cacheKey(model);
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now() && !existing.inflight) {
    return applyCachedOllamaContextWindow(model);
  }
  if (!existing?.inflight) {
    const origin = originFor(model);
    const modelId = model.id;
    const inflight = (async () => {
      let win: number | undefined;
      try {
        win = (await probePs(origin, modelId)) ?? (await probeShow(origin, modelId));
      } catch (err) {
        log.debug(
          `probe failed for ${origin} (${modelId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      cache.set(key, {
        window: win,
        expiresAt: Date.now() + (win === undefined ? NEG_TTL_MS : TTL_MS),
      });
      return win;
    })();
    cache.set(key, { ...(existing ?? { expiresAt: 0 }), inflight });
  }
  await cache.get(key)?.inflight;
  return applyCachedOllamaContextWindow(model);
}

/** Test seam — clears the in-memory cache. */
export function __resetOllamaContextCache(): void {
  cache.clear();
}
