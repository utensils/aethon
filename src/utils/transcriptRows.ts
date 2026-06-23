import type { ToolCallsMode } from "../config";
import type { ChatMessage } from "../types/a2ui";
import {
  groupKey,
  groupMessages,
  isToolCardMessage,
  type MessageGroup,
} from "./toolCardGrouping";

export type TranscriptRow =
  | {
      type: "message";
      message: ChatMessage;
      group: Extract<MessageGroup, { type: "single" }>;
    }
  | {
      type: "tool-group-summary";
      group: Extract<MessageGroup, { type: "tool-group" }>;
    }
  | {
      type: "tool-group-child";
      group: Extract<MessageGroup, { type: "tool-group" }>;
      message: ChatMessage;
      childIndex: number;
    }
  | {
      type: "turn-block-summary";
      group: Extract<MessageGroup, { type: "turn-block" }>;
    }
  | {
      type: "turn-block-child";
      group: Extract<MessageGroup, { type: "turn-block" }>;
      message: ChatMessage;
      childIndex: number;
    };

export interface TranscriptModel {
  groups: MessageGroup[];
  rows: TranscriptRow[];
  heightEstimates: number[];
}

export function buildTranscriptRows(
  messages: ChatMessage[],
  mode: ToolCallsMode,
  expandedGroupIds: ReadonlySet<string>,
): TranscriptModel {
  const groups = groupMessages(messages, mode);
  const rows: TranscriptRow[] = [];
  for (const group of groups) {
    if (group.type === "single") {
      rows.push({ type: "message", message: group.message, group });
      continue;
    }
    if (group.type === "tool-group") {
      rows.push({ type: "tool-group-summary", group });
      if (expandedGroupIds.has(group.id)) {
        group.messages.forEach((message, childIndex) => {
          rows.push({ type: "tool-group-child", group, message, childIndex });
        });
      }
      continue;
    }
    rows.push({ type: "turn-block-summary", group });
    if (expandedGroupIds.has(group.id)) {
      group.messages.forEach((message, childIndex) => {
        rows.push({ type: "turn-block-child", group, message, childIndex });
      });
    }
  }
  return {
    groups,
    rows,
    heightEstimates: rows.map(heightEstimateForRow),
  };
}

export function rowKey(row: TranscriptRow): string {
  switch (row.type) {
    case "message":
      return `msg-${row.message.id}`;
    case "tool-group-summary":
    case "turn-block-summary":
      return groupKey(row.group);
    case "tool-group-child":
    case "turn-block-child":
      return `${groupKey(row.group)}:child:${row.message.id}`;
  }
}

export function anchorMessageIdForRow(
  row: TranscriptRow | undefined,
): string | undefined {
  if (!row) return undefined;
  switch (row.type) {
    case "message":
    case "tool-group-child":
    case "turn-block-child":
      return row.message.id;
    case "tool-group-summary":
    case "turn-block-summary":
      return row.group.messages[0]?.id;
  }
}

export function findRowIndexForMessageId(
  rows: readonly TranscriptRow[],
  id: string | undefined,
): number {
  if (!id) return -1;
  const directIndex = rows.findIndex((row) => {
    switch (row.type) {
      case "message":
      case "tool-group-child":
      case "turn-block-child":
        return row.message.id === id;
      case "tool-group-summary":
      case "turn-block-summary":
        return false;
    }
  });
  if (directIndex >= 0) return directIndex;
  return rows.findIndex((row) => {
    switch (row.type) {
      case "message":
      case "tool-group-child":
      case "turn-block-child":
        return false;
      case "tool-group-summary":
      case "turn-block-summary":
        return row.group.messages.some((message) => message.id === id);
    }
  });
}

export function rowMessageRole(row: TranscriptRow | undefined): string | undefined {
  if (!row) return undefined;
  switch (row.type) {
    case "message":
    case "turn-block-child":
      return row.message.role;
    case "tool-group-summary":
    case "tool-group-child":
    case "turn-block-summary":
      return "agent";
  }
}

export function searchableTextForRow(row: TranscriptRow): string {
  switch (row.type) {
    case "message":
    case "turn-block-child":
      return searchableTextForMessage(row.message);
    case "tool-group-summary":
    case "turn-block-summary":
      return row.group.messages.map(searchableTextForMessage).join("\n");
    case "tool-group-child":
      return searchableTextForMessage(row.message);
  }
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
  switch (row.type) {
    case "tool-group-summary":
      return 52;
    case "turn-block-summary":
      return 64;
    case "tool-group-child":
      return 148;
    case "turn-block-child":
    case "message":
      return estimateMessageHeight(row.message);
  }
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
  const base = message.role === "user" ? 92 : message.role === "system" ? 72 : 112;
  return base + textBonus + lineBonus + codeFenceBonus + attachmentBonus;
}
