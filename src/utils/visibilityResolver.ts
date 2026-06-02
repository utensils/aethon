import { normalizeVisibility, type VisibilityMode } from "../config";
import type { Tab } from "../types/tab";

export interface ResolvedVisibility {
  thinking: VisibilityMode;
  toolCalls: VisibilityMode;
}

/**
 * Resolve effective transcript visibility for a tab: a concrete per-tab
 * override wins; otherwise fall back to the global default mirrored at
 * `/transcriptVisibility` (seeded from `[ui]` config); otherwise `show`.
 *
 * Kept pure (state + tabId in, modes out) so it's trivially testable and the
 * renderer can memoize on `[state, tabId]`.
 */
export function resolveVisibility(
  state: Record<string, unknown>,
  tabId: string | undefined,
): ResolvedVisibility {
  const global = (state.transcriptVisibility ?? {}) as {
    thinking?: unknown;
    toolCalls?: unknown;
  };
  const globalThinking = normalizeVisibility(global.thinking);
  const globalTool = normalizeVisibility(global.toolCalls);

  const overrides = findTabOverrides(state, tabId);
  return {
    thinking: pick(overrides?.thinking, globalThinking),
    toolCalls: pick(overrides?.toolCalls, globalTool),
  };
}

function findTabOverrides(
  state: Record<string, unknown>,
  tabId: string | undefined,
): Tab["visibilityOverrides"] | undefined {
  if (!tabId) return undefined;
  const tabs = state.tabs;
  if (!Array.isArray(tabs)) return undefined;
  const tab = (tabs as Tab[]).find((t) => t?.id === tabId);
  return tab?.visibilityOverrides;
}

/** A per-tab override only wins when it's an explicit mode; null/undefined
 *  (the "follow global" sentinel) defers to the global default. */
function pick(
  override: VisibilityMode | null | undefined,
  fallback: VisibilityMode,
): VisibilityMode {
  return override === "show" ||
    override === "collapse" ||
    override === "hide"
    ? override
    : fallback;
}
