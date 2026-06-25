import type { ChatMessage } from "../../types/a2ui";
import type { VisibilityMode } from "../../config";

export function hasDisplayableAgentContent(
  message: ChatMessage,
  thinkingVisibility: VisibilityMode,
): boolean {
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return true;
  }
  if (message.a2ui) return true;
  return (
    thinkingVisibility === "show" &&
    typeof message.thinking === "string" &&
    message.thinking.trim().length > 0
  );
}
