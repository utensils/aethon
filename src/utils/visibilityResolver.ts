import {
  normalizeToolCallsVisibility,
  normalizeVisibility,
  type ToolCallsMode,
  type VisibilityMode,
} from "../config";
import type { Tab } from "../types/tab";

export interface ResolvedVisibility {
  thinking: VisibilityMode;
  toolCalls: ToolCallsMode;
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
  const globalTool = normalizeToolCallsVisibility(global.toolCalls);

  const overrides = findTabOverrides(state, tabId);
  return {
    thinking: pick(overrides?.thinking, globalThinking),
    toolCalls: pickTool(overrides?.toolCalls, globalTool),
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

/** Tool-call flavor of `pick`. Accepts the five tool modes; a legacy
 *  `"collapse"` override (persisted by PR #204) migrates to `group-turn`;
 *  null/undefined/unknown defer to the global default. Typed `unknown` because
 *  the value can come from on-disk session snapshots that predate the enum. */
function pickTool(override: unknown, fallback: ToolCallsMode): ToolCallsMode {
  switch (override) {
    case "show":
    case "group-turn":
    case "group-run":
    case "group-block":
    case "hide":
      return override;
    case "collapse":
      return "group-turn";
    default:
      return fallback;
  }
}
