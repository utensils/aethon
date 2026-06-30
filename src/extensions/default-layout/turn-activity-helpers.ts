import type { ChatMessage } from "../../types/a2ui";
import type { VisibilityMode } from "../../config";
import { splitThinkingBlocks } from "../../utils/thinkingBlocks";

export interface TextDisplayVisibility {
  visible: boolean;
  hiddenThinkingOnly: boolean;
}

export function textDisplayVisibility(
  text: unknown,
  thinkingVisibility: VisibilityMode,
): TextDisplayVisibility {
  if (typeof text !== "string" || text.length === 0) {
    return { visible: false, hiddenThinkingOnly: false };
  }
  const segments = splitThinkingBlocks(text);
  let hasHiddenThinking = false;
  let hasVisibleContent = false;
  for (const segment of segments) {
    if (segment.content.trim().length === 0) continue;
    if (segment.type === "thinking" && thinkingVisibility !== "show") {
      hasHiddenThinking = true;
      continue;
    }
    hasVisibleContent = true;
  }
  return {
    visible: hasVisibleContent,
    hiddenThinkingOnly: hasHiddenThinking && !hasVisibleContent,
  };
}

export function hasDisplayableAgentContent(
  message: ChatMessage,
  thinkingVisibility: VisibilityMode,
): boolean {
  if (textDisplayVisibility(message.text, thinkingVisibility).visible) {
    return true;
  }
  if (message.a2ui) return true;
  return (
    thinkingVisibility === "show" &&
    typeof message.thinking === "string" &&
    message.thinking.trim().length > 0
  );
}
