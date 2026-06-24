/**
 * Pi (Anthropic-format) JSONL transcript parser. Walks each line,
 * decodes `message` records (user / assistant / toolResult), and emits
 * RestoredChatMessage entries with tool-card payloads attached for
 * `toolCall` blocks. Tool-result records back-fill the matching
 * tool-card by message index so the result lands on the same UI id.
 */

import { stripExpandedFileReferences } from "../file-references";
import { isSilentTool } from "../silent-tools";
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

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function parseRecordTime(record: Record<string, unknown>): number | undefined {
  const timestamp = record.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function compactionMessage(record: Record<string, unknown>): RestoredChatMessage | undefined {
  const id =
    typeof record.id === "string" && record.id.length > 0
      ? record.id
      : undefined;
  if (!id) return undefined;
  const tokensBefore =
    typeof record.tokensBefore === "number" && Number.isFinite(record.tokensBefore)
      ? record.tokensBefore
      : undefined;
  const createdAt = parseRecordTime(record);
  return {
    id: `compaction:${id}`,
    role: "system",
    text:
      tokensBefore !== undefined
        ? `Context compacted · ${formatInt(tokensBefore)} tokens summarized`
        : "Context compacted",
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

interface RestoredToolCall {
  messageIndex: number;
  uiId: string;
  toolName: string;
  argsSummary: string;
  args?: unknown;
  startedAt?: number;
}

function toolCardMessage(opts: {
  uiId: string;
  toolName: string;
  argsSummary: string;
  result?: unknown;
  isError?: boolean;
  args?: unknown;
  startedAt?: number;
  endedAt?: number;
}): RestoredChatMessage {
  const createdAt = opts.startedAt ?? opts.endedAt;
  return {
    id: opts.uiId,
    role: "agent",
    a2ui: toolCardPayload({
      id: opts.uiId,
      toolName: opts.toolName,
      argsSummary: opts.argsSummary,
      ...(opts.args !== undefined ? { args: opts.args } : {}),
      ...(opts.result !== undefined ? { result: opts.result } : {}),
      ...(opts.isError !== undefined ? { isError: opts.isError } : {}),
      ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
      ...(opts.endedAt !== undefined ? { endedAt: opts.endedAt } : {}),
    }),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

export function parseSessionHistoryLines(
  lines: Iterable<string>,
): RestoredChatMessage[] {
  const messages: RestoredChatMessage[] = [];
  const seen = new Set<string>();
  const toolCalls = new Map<string, RestoredToolCall>();
  const modelByAssistantId = new Map<string, string>();
  let currentModel: string | undefined;

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
    if (record.type === "compaction") {
      const message = compactionMessage(record);
      if (message && !seen.has(message.id)) {
        seen.add(message.id);
        messages.push(message);
      }
      continue;
    }
    if (record.type === "model_change") {
      const provider =
        typeof record.provider === "string" && record.provider.length > 0
          ? record.provider
          : undefined;
      const modelId =
        typeof record.modelId === "string" && record.modelId.length > 0
          ? record.modelId
          : undefined;
      const model =
        provider && modelId
          ? `${provider}/${modelId}`
          : typeof record.model === "string" && record.model.length > 0
            ? record.model
            : undefined;
      if (model) {
        currentModel = model;
        if (
          typeof record.parentId === "string" &&
          record.parentId.length > 0
        ) {
          modelByAssistantId.set(record.parentId, model);
          const existing = messages.find(
            (message) =>
              message.id === record.parentId && message.role === "agent",
          );
          if (existing) existing.model = model;
        }
      }
      continue;
    }
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
      if (isSilentTool(toolName)) continue;
      const endedAt = parseMessageTime(record, msg);
      const result = {
        content: msg.content,
        ...(msg.details !== undefined ? { details: msg.details } : {}),
      };
      const isError = msg.isError === true;
      const cached = toolCallId ? toolCalls.get(toolCallId) : undefined;
      if (cached) {
        messages[cached.messageIndex] = toolCardMessage({
          uiId: cached.uiId,
          toolName: cached.toolName,
          argsSummary: cached.argsSummary,
          ...(cached.args !== undefined ? { args: cached.args } : {}),
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

    const rawText = textFromContent(msg.content);
    const text =
      role === "user" ? stripExpandedFileReferences(rawText) : rawText;
    const thinking = role === "agent" ? thinkingFromContent(msg.content) : "";

    const hasRealId = typeof record.id === "string" && record.id.length > 0;
    const id = hasRealId
      ? (record.id as string)
      : `restored-${messages.length}`;
    const model =
      role === "agent"
        ? modelByAssistantId.get(id) ?? currentModel
        : undefined;
    if ((text || thinking) && !seen.has(id)) {
      seen.add(id);
      const createdAt = parseMessageTime(record, msg);
      messages.push({
        id,
        // The pi entry id is the rollback/fork handle. Only carry it when it's
        // a real session id (not the positional `restored-N` fallback).
        ...(hasRealId ? { entryId: id } : {}),
        role,
        ...(model ? { model } : {}),
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
      if (isSilentTool(toolName)) continue;
      const args = "arguments" in toolCall ? toolCall.arguments : undefined;
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
          ...(args !== undefined ? { args } : {}),
          ...(startedAt !== undefined ? { startedAt } : {}),
        }),
      );
      toolCalls.set(toolCallId, {
        messageIndex,
        uiId,
        toolName,
        argsSummary,
        ...(args !== undefined ? { args } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
      });
    }
  }

  return messages.slice(-MAX_RESTORED_MESSAGES);
}
