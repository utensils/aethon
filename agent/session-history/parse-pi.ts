/**
 * Pi (Anthropic-format) JSONL transcript parser. Walks each line,
 * decodes `message` records (user / assistant / toolResult), and emits
 * RestoredChatMessage entries with tool-card payloads attached for
 * `toolCall` blocks. Tool-result records back-fill the matching
 * tool-card by message index so the result lands on the same UI id.
 */

import { summarizeToolArgs, toolCardPayload } from "../tool-card";
import {
  MAX_RESTORED_MESSAGES,
  type RestoredChatMessage,
  textFromContent,
  thinkingFromContent,
  trimText,
} from "./shared";

function parseMessageTime(
  record: Record<string, unknown>,
  msg: Record<string, unknown>,
): number | undefined {
  const candidates = [msg.timestamp, record.timestamp];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function restoredToolUiId(toolCallId: string): string {
  const safe = toolCallId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 96);
  return `restored-tool-${safe || "unknown"}`;
}

interface RestoredToolCall {
  messageIndex: number;
  uiId: string;
  toolName: string;
  argsSummary: string;
  startedAt?: number;
}

function toolCardMessage(opts: {
  uiId: string;
  toolName: string;
  argsSummary: string;
  result?: unknown;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
}): RestoredChatMessage {
  return {
    id: opts.uiId,
    role: "agent",
    a2ui: toolCardPayload({
      id: opts.uiId,
      toolName: opts.toolName,
      argsSummary: opts.argsSummary,
      ...(opts.result !== undefined ? { result: opts.result } : {}),
      ...(opts.isError !== undefined ? { isError: opts.isError } : {}),
      ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
      ...(opts.endedAt !== undefined ? { endedAt: opts.endedAt } : {}),
    }),
  };
}

export function parseSessionHistoryLines(
  lines: Iterable<string>,
): RestoredChatMessage[] {
  const messages: RestoredChatMessage[] = [];
  const seen = new Set<string>();
  const toolCalls = new Map<string, RestoredToolCall>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "message") continue;

    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    const sourceRole = msg.role;
    if (sourceRole === "toolResult") {
      const toolCallId =
        typeof msg.toolCallId === "string" && msg.toolCallId.length > 0
          ? msg.toolCallId
          : undefined;
      const toolName =
        typeof msg.toolName === "string" && msg.toolName.length > 0
          ? msg.toolName
          : "tool";
      const endedAt = parseMessageTime(record, msg);
      const result = {
        content: msg.content,
      };
      const isError = msg.isError === true;
      const cached = toolCallId ? toolCalls.get(toolCallId) : undefined;
      if (cached) {
        messages[cached.messageIndex] = toolCardMessage({
          uiId: cached.uiId,
          toolName: cached.toolName,
          argsSummary: cached.argsSummary,
          result,
          isError,
          ...(cached.startedAt !== undefined
            ? { startedAt: cached.startedAt }
            : {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
        });
        continue;
      }
      const uiId = restoredToolUiId(toolCallId ?? `result-${messages.length}`);
      if (seen.has(uiId)) continue;
      seen.add(uiId);
      messages.push(
        toolCardMessage({
          uiId,
          toolName,
          argsSummary: "",
          result,
          isError,
          ...(endedAt !== undefined ? { endedAt } : {}),
        }),
      );
      continue;
    }

    const role =
      sourceRole === "user"
        ? "user"
        : sourceRole === "assistant"
          ? "agent"
          : null;
    if (!role) continue;

    const text = textFromContent(msg.content);
    const thinking = role === "agent" ? thinkingFromContent(msg.content) : "";

    const id =
      typeof record.id === "string" && record.id.length > 0
        ? record.id
        : `restored-${messages.length}`;
    if ((text || thinking) && !seen.has(id)) {
      seen.add(id);
      const createdAt = parseMessageTime(record, msg);
      messages.push({
        id,
        role,
        ...(text ? { text: trimText(text) } : {}),
        ...(thinking ? { thinking: trimText(thinking) } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
      });
    }

    if (role !== "agent" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      const toolCall = part as Record<string, unknown>;
      if (toolCall.type !== "toolCall") continue;
      const toolCallId =
        typeof toolCall.id === "string" && toolCall.id.length > 0
          ? toolCall.id
          : undefined;
      if (!toolCallId || toolCalls.has(toolCallId)) continue;
      const toolName =
        typeof toolCall.name === "string" && toolCall.name.length > 0
          ? toolCall.name
          : "tool";
      const args =
        "arguments" in toolCall ? toolCall.arguments : undefined;
      const argsSummary = summarizeToolArgs(toolName, args);
      const startedAt = parseMessageTime(record, msg);
      const uiId = restoredToolUiId(toolCallId);
      if (seen.has(uiId)) continue;
      seen.add(uiId);
      const messageIndex = messages.length;
      messages.push(
        toolCardMessage({
          uiId,
          toolName,
          argsSummary,
          ...(startedAt !== undefined ? { startedAt } : {}),
        }),
      );
      toolCalls.set(toolCallId, {
        messageIndex,
        uiId,
        toolName,
        argsSummary,
        ...(startedAt !== undefined ? { startedAt } : {}),
      });
    }
  }

  return messages.slice(-MAX_RESTORED_MESSAGES);
}
