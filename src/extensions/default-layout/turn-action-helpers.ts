import type { ChatMessage } from "../../types/a2ui";
import type { ConversationTurn } from "../../utils/transcriptRows";

export function isBranchableTurnMessage(message: ChatMessage): boolean {
  return (
    Boolean(message.entryId) &&
    (message.role === "user" || message.role === "agent") &&
    (Boolean(message.text) || Boolean(message.thinking))
  );
}

export interface TurnBranchTargets {
  rollbackTarget?: ChatMessage;
  forkTarget?: ChatMessage;
}

export function branchTargetsForTurn(
  turn: ConversationTurn,
  visibleAgentMessages: ChatMessage[],
): TurnBranchTargets {
  const rollbackTarget =
    turn.userMessage && isBranchableTurnMessage(turn.userMessage)
      ? turn.userMessage
      : undefined;
  const forkTarget = [turn.userMessage, ...visibleAgentMessages]
    .filter((message): message is ChatMessage => Boolean(message))
    .filter(isBranchableTurnMessage)
    .at(-1);
  return { rollbackTarget, forkTarget };
}
