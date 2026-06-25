import type { ChatMessage } from "../../types/a2ui";
import type { ConversationTurn } from "../../utils/transcriptRows";

export function isBranchableTurnMessage(message: ChatMessage): boolean {
  return (
    Boolean(message.entryId) &&
    (message.role === "user" || message.role === "agent") &&
    (Boolean(message.text) || Boolean(message.thinking))
  );
}

export function branchTargetForTurn(
  turn: ConversationTurn,
  visibleAgentMessages: ChatMessage[],
): ChatMessage | undefined {
  return [turn.userMessage, ...visibleAgentMessages]
    .filter((message): message is ChatMessage => Boolean(message))
    .filter(isBranchableTurnMessage)
    .at(-1);
}
