import type { ChatMessage } from "../../types/a2ui";
import {
  anchorMessageIdForRow,
  findRowIndexForMessageId,
  type TranscriptRow,
} from "../../utils/transcriptRows";

export function visibilityReanchorIndex({
  messages,
  newRows,
  oldRows,
  startIndex,
}: {
  messages: ChatMessage[];
  newRows: TranscriptRow[];
  oldRows: TranscriptRow[];
  startIndex: number;
}): number {
  const anchorId = anchorMessageIdForRow(oldRows[startIndex]);
  const newIndex = findRowIndexForMessageId(newRows, anchorId);
  if (newIndex >= 0 || !anchorId) return newIndex;

  const anchorMsgIdx = messages.findIndex((message) => message.id === anchorId);
  for (let i = anchorMsgIdx - 1; i >= 0; i--) {
    const idx = findRowIndexForMessageId(newRows, messages[i].id);
    if (idx >= 0) return idx;
  }
  return -1;
}

export function appendedMessagesAfterPreviousTail({
  messages,
  previousTailId,
}: {
  messages: ChatMessage[];
  previousTailId: string | undefined;
}): ChatMessage[] {
  const previousIndex = previousTailId
    ? messages.findIndex((message) => message.id === previousTailId)
    : -1;
  return previousIndex >= 0 ? messages.slice(previousIndex + 1) : messages;
}

export function appendedUserTurnResumesFollow({
  messages,
  previousTailId,
}: {
  messages: ChatMessage[];
  previousTailId: string | undefined;
}): boolean {
  const latest = messages[messages.length - 1];
  if (!latest || latest.id === previousTailId) return false;
  return appendedMessagesAfterPreviousTail({ messages, previousTailId }).some(
    (message) => message.role === "user",
  );
}
