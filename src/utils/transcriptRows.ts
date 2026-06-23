import type { ToolCallsMode } from "../config";
import type { ChatMessage } from "../types/a2ui";
import { isToolCardMessage } from "./toolCardGrouping";

export type TranscriptRow = {
  type: "conversation-turn";
  turn: ConversationTurn;
};

export interface TranscriptModel {
  groups: ConversationTurn[];
  rows: TranscriptRow[];
  heightEstimates: number[];
}

export interface ConversationTurn {
  id: string;
  messages: ChatMessage[];
  userMessage?: ChatMessage;
  agentMessages: ChatMessage[];
  progressMessages: ChatMessage[];
  finalMessage?: ChatMessage;
  toolMessages: ChatMessage[];
  systemMessages: ChatMessage[];
}

export function buildTranscriptRows(
  messages: ChatMessage[],
  mode: ToolCallsMode,
  _expandedGroupIds: ReadonlySet<string>,
): TranscriptModel {
  const turns = buildConversationTurns(messages, mode);
  const rows: TranscriptRow[] = turns.map((turn) => ({
    type: "conversation-turn",
    turn,
  }));
  return {
    groups: turns,
    rows,
    heightEstimates: rows.map(heightEstimateForRow),
  };
}

export function rowKey(row: TranscriptRow): string {
  return `turn-${row.turn.id}`;
}

export function anchorMessageIdForRow(
  row: TranscriptRow | undefined,
): string | undefined {
  if (!row) return undefined;
  return row.turn.messages[0]?.id;
}

export function findRowIndexForMessageId(
  rows: readonly TranscriptRow[],
  id: string | undefined,
): number {
  if (!id) return -1;
  return rows.findIndex((row) =>
    row.turn.messages.some((message) => message.id === id),
  );
}

export function rowMessageRole(
  row: TranscriptRow | undefined,
): string | undefined {
  if (!row) return undefined;
  return row.turn.messages.at(-1)?.role;
}

export function searchableTextForRow(row: TranscriptRow): string {
  return row.turn.messages.map(searchableTextForMessage).join("\n");
}

function searchableTextForMessage(message: ChatMessage): string {
  const parts = [message.text ?? ""];
  for (const component of message.a2ui?.components ?? []) {
    if (component.type !== "tool-card") continue;
    const props = component.props ?? {};
    for (const key of ["title", "description", "status", "toolName"]) {
      const value = props[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.filter(Boolean).join("\n");
}

export function heightEstimateForRow(row: TranscriptRow): number {
  const { turn } = row;
  const visibleMessages =
    (turn.userMessage ? 1 : 0) +
    (turn.finalMessage ? 1 : 0) +
    turn.systemMessages.length;
  const textHeight =
    (turn.userMessage ? estimateMessageHeight(turn.userMessage) : 0) +
    (turn.finalMessage ? estimateMessageHeight(turn.finalMessage) : 0) +
    turn.systemMessages.reduce(
      (sum, message) => sum + estimateMessageHeight(message),
      0,
    );
  const activityHeight =
    turn.toolMessages.length > 0 || turn.progressMessages.length > 0 ? 44 : 0;
  return Math.max(96, textHeight + activityHeight + visibleMessages * 6);
}

function buildConversationTurns(
  messages: ChatMessage[],
  mode: ToolCallsMode,
): ConversationTurn[] {
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns
    .map((turnMessages, index) =>
      buildConversationTurn(turnMessages, index, mode),
    )
    .filter((turn) => turn.messages.length > 0);
}

function buildConversationTurn(
  messages: ChatMessage[],
  index: number,
  mode: ToolCallsMode,
): ConversationTurn {
  const visibleMessages =
    mode === "hide"
      ? messages.filter((message) => !isToolCardMessage(message))
      : messages;
  const userMessage = visibleMessages.find(
    (message) => message.role === "user",
  );
  const toolMessages =
    mode === "hide"
      ? []
      : visibleMessages.filter((message) => isToolCardMessage(message));
  const systemMessages = visibleMessages.filter(
    (message) => message.role === "system",
  );
  const agentMessages = visibleMessages.filter(
    (message) =>
      message.role === "agent" &&
      !isToolCardMessage(message) &&
      (Boolean(message.text) ||
        Boolean(message.thinking) ||
        Boolean(message.a2ui)),
  );
  const finalMessage = agentMessages.at(-1);
  const progressMessages = finalMessage
    ? agentMessages.filter((message) => message !== finalMessage)
    : agentMessages;
  return {
    id: userMessage?.id ?? visibleMessages[0]?.id ?? `turn-${index}`,
    messages: visibleMessages,
    ...(userMessage ? { userMessage } : {}),
    agentMessages,
    progressMessages,
    ...(finalMessage ? { finalMessage } : {}),
    toolMessages,
    systemMessages,
  };
}

function estimateMessageHeight(message: ChatMessage): number {
  if (isToolCardMessage(message)) return 156;
  const text = message.text ?? "";
  const attachmentCount = message.attachments?.length ?? 0;
  const lineCount = text.length === 0 ? 0 : text.split("\n").length;
  const codeFenceBonus = /(^|\n)(```|~~~)/.test(text) ? 120 : 0;
  const textBonus = Math.min(360, Math.ceil(text.length / 90) * 22);
  const lineBonus = Math.min(240, lineCount * 12);
  const attachmentBonus = attachmentCount > 0 ? 96 : 0;
  const base =
    message.role === "user" ? 92 : message.role === "system" ? 72 : 112;
  return base + textBonus + lineBonus + codeFenceBonus + attachmentBonus;
}
