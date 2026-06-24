import type { EventRouteHandler } from "./types";
import { resolveVisibility } from "../utils/visibilityResolver";
import type { ToolCallsMode, VisibilityMode } from "../config";
import type { Tab } from "../types/tab";

// The UI intentionally exposes only the two decisions users make in the chat:
// thinking on/off and tool calls on/off. Older persisted grouped modes still
// resolve, but the button no longer walks users through them.
function nextThinking(current: VisibilityMode): VisibilityMode {
  return current === "show" ? "hide" : "show";
}

function nextToolCalls(current: ToolCallsMode): ToolCallsMode {
  return current === "show" ? "hide" : "show";
}

function simplifiedThinkingDefault(current: VisibilityMode): VisibilityMode {
  return current === "show" ? "show" : "hide";
}

function simplifiedToolCallsDefault(current: ToolCallsMode): ToolCallsMode {
  return current;
}

const GROUPING_MODES: readonly ToolCallsMode[] = [
  "group-turn",
  "group-run",
  "group-block",
];

/**
 * Composer visibility pills (`type:composer-visibility-pills`):
 *   - `cycle`            — toggle the active session's override for one
 *                          category. Thinking: show ↔ hide. Tool calls:
 *                          show ↔ hide.
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

  if (event.eventType === "toggle-plan") {
    const tabs = (state.tabs as Tab[] | undefined) ?? [];
    const activeTab = tabs.find((tab) => tab.id === activeId);
    if (!activeTab || activeTab.kind !== "agent") return true;
    const enabled = activeTab.planMode !== true;
    ctx.updateActiveTab((tab) => {
      if (tab.kind !== "agent") return tab;
      return { ...tab, planMode: enabled };
    });
    ctx.pushNotification({
      title: enabled ? "Plan mode on" : "Implementation mode on",
      message: enabled
        ? "New prompts will ask for a plan before code changes."
        : "New prompts may make code changes.",
      kind: "success",
      durationMs: 1600,
    });
    return true;
  }

  if (event.eventType === "cycle") {
    const category = (event.data as { category?: unknown } | undefined)
      ?.category;
    const eff = resolveVisibility(state, activeId);
    if (category === "thinking") {
      const next = nextThinking(eff.thinking);
      ctx.updateActiveTab((tab) => ({
        ...tab,
        visibilityOverrides: { ...tab.visibilityOverrides, thinking: next },
      }));
      return true;
    }
    if (category === "toolCalls") {
      const next = nextToolCalls(eff.toolCalls);
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
        thinkingVisibility: simplifiedThinkingDefault(eff.thinking),
        toolCallsVisibility: simplifiedToolCallsDefault(eff.toolCalls),
      },
    });
    return true;
  }

  return false;
};
