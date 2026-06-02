import type { EventRouteHandler } from "./types";
import { resolveVisibility } from "../utils/visibilityResolver";
import type { VisibilityMode } from "../config";

const CYCLE: readonly VisibilityMode[] = ["show", "collapse", "hide"];

function nextMode(current: VisibilityMode): VisibilityMode {
  const i = CYCLE.indexOf(current);
  return CYCLE[(i + 1) % CYCLE.length];
}

/**
 * Composer visibility pills (`type:composer-visibility-pills`):
 *   - `cycle`       — advance the active session's override for one category
 *                     (thinking / toolCalls) show → collapse → hide → show.
 *   - `set-default` — promote the active session's *effective* visibility to
 *                     the global config default (all future sessions).
 *
 * Cycling reads the effective value (per-tab override ?? global) so the first
 * click moves off whatever the user currently sees, not off a stale null.
 */
export const handleComposerPills: EventRouteHandler = (event, ctx) => {
  if (event.component.type !== "composer-visibility-pills") return false;
  const state = ctx.stateRef.current;
  const activeId =
    typeof state.activeTabId === "string" ? state.activeTabId : undefined;

  if (event.eventType === "cycle") {
    const category = (event.data as { category?: unknown } | undefined)
      ?.category;
    if (category !== "thinking" && category !== "toolCalls") return true;
    const next = nextMode(resolveVisibility(state, activeId)[category]);
    ctx.updateActiveTab((tab) => ({
      ...tab,
      visibilityOverrides: { ...tab.visibilityOverrides, [category]: next },
    }));
    return true;
  }

  if (event.eventType === "set-default") {
    const eff = resolveVisibility(state, activeId);
    ctx.applySettingsPatch({
      ui: {
        thinkingVisibility: eff.thinking,
        toolCallsVisibility: eff.toolCalls,
      },
    });
    return true;
  }

  return false;
};
