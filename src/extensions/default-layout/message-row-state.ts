import type { VisibilityMode } from "../../config";
import { textDisplayVisibility } from "./turn-activity-helpers";

export function tabIsRunning(
  state: Record<string, unknown>,
  tabId?: string,
): boolean {
  if (!tabId) return state.waiting === true;
  const runningTabs = state.agentRunningTabs;
  if (
    runningTabs &&
    typeof runningTabs === "object" &&
    Boolean((runningTabs as Record<string, unknown>)[tabId])
  ) {
    return true;
  }
  const activeTabId =
    typeof state.activeTabId === "string" ? state.activeTabId : undefined;
  if (activeTabId !== undefined && activeTabId !== tabId) return false;
  return state.waiting === true;
}

export interface FallbackAgentActivity {
  label: string;
  detail: string;
}

export function fallbackAgentActivityForTab(
  state: Record<string, unknown>,
  tabId: string | undefined,
  messages: readonly { role?: unknown; text?: unknown; thinking?: unknown }[],
  options: { allowEmpty?: boolean; thinkingVisibility?: VisibilityMode } = {},
): FallbackAgentActivity | null {
  if (!tabIsRunning(state, tabId)) return null;
  if (messages.length === 0 && options.allowEmpty !== true) return null;
  const latestMessage = messages.at(-1);
  const thinkingVisibility = options.thinkingVisibility ?? "show";
  const textVisibility =
    latestMessage?.role === "agent"
      ? textDisplayVisibility(latestMessage.text, thinkingVisibility)
      : { visible: false, hiddenThinkingOnly: false };
  const latestAgentTextVisible = textVisibility.visible;
  const latestAgentThinkingPresent =
    latestMessage?.role === "agent" &&
    typeof latestMessage.thinking === "string" &&
    latestMessage.thinking.length > 0;
  const latestAgentThinkingVisible =
    thinkingVisibility === "show" && latestAgentThinkingPresent;
  if (
    (latestAgentThinkingPresent || textVisibility.hiddenThinkingOnly) &&
    !latestAgentTextVisible &&
    !latestAgentThinkingVisible
  ) {
    return null;
  }
  const latestAgentProseVisible =
    latestAgentTextVisible || latestAgentThinkingVisible;
  return latestAgentProseVisible
    ? {
        label: "Writing response",
        detail: "Streaming the answer",
      }
    : {
        label: "Thinking through next step",
        detail: "Waiting for the next update",
      };
}
