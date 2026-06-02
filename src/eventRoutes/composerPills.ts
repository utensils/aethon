import type { EventRouteHandler } from "./types";
import { resolveVisibility } from "../utils/visibilityResolver";
import type { ToolCallsMode, VisibilityMode } from "../config";

// Thinking cycles show → collapse → hide. Tool calls cycle through the three
// grouping styles between show and hide so one pill reaches every mode.
const THINKING_CYCLE: readonly VisibilityMode[] = ["show", "collapse", "hide"];
const TOOLCALLS_CYCLE: readonly ToolCallsMode[] = [
  "show",
  "group-turn",
  "group-run",
  "group-block",
  "hide",
];

function nextIn<T>(cycle: readonly T[], current: T): T {
  const i = cycle.indexOf(current);
  return cycle[(i + 1) % cycle.length];
}

const GROUPING_MODES: readonly ToolCallsMode[] = [
  "group-turn",
  "group-run",
  "group-block",
];

/**
 * Composer visibility pills (`type:composer-visibility-pills`):
 *   - `cycle`            — advance the active session's override for one
 *                          category. Thinking: show → collapse → hide. Tool
 *                          calls: show → group-turn → group-run → group-block →
 *                          hide.
 *   - `set-tool-grouping`— jump the active session's tool-call mode straight to
 *                          a specific grouping style (popover radios).
 *   - `reset-to-global`  — drop the session's per-tab overrides so it follows
 *                          the global defaults again.
 *   - `toggle-guardrail` — flip the per-session hard project-root guardrail.
 *   - `set-default`      — promote the active session's *effective* visibility
 *                          to the global config default (all future sessions).
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
    const eff = resolveVisibility(state, activeId);
    if (category === "thinking") {
      const next = nextIn(THINKING_CYCLE, eff.thinking);
      ctx.updateActiveTab((tab) => ({
        ...tab,
        visibilityOverrides: { ...tab.visibilityOverrides, thinking: next },
      }));
      return true;
    }
    if (category === "toolCalls") {
      const next = nextIn(TOOLCALLS_CYCLE, eff.toolCalls);
      ctx.updateActiveTab((tab) => ({
        ...tab,
        visibilityOverrides: { ...tab.visibilityOverrides, toolCalls: next },
      }));
      return true;
    }
    return true;
  }

  if (event.eventType === "set-tool-grouping") {
    const mode = (event.data as { mode?: unknown } | undefined)?.mode;
    if (!GROUPING_MODES.includes(mode as ToolCallsMode)) return true;
    ctx.updateActiveTab((tab) => ({
      ...tab,
      visibilityOverrides: {
        ...tab.visibilityOverrides,
        toolCalls: mode as ToolCallsMode,
      },
    }));
    return true;
  }

  if (event.eventType === "reset-to-global") {
    ctx.updateActiveTab((tab) => ({ ...tab, visibilityOverrides: undefined }));
    return true;
  }

  if (event.eventType === "toggle-guardrail") {
    const next = (event.data as { next?: unknown } | undefined)?.next === true;
    ctx.updateActiveTab((tab) => ({ ...tab, hardEnforceProjectRoot: next }));
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
