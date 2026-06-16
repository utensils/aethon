import type { ChatMessage } from "../types/a2ui";

export interface NormalizedAgentMessage {
  text?: string;
  thinking?: string;
}

const THINKING_TAG_RE = /<\/?(?:think|thinking)>/gi;
const TOOL_CALL_START = "<|tool_call_start|>";
const TOOL_CALL_END = "<|tool_call_end|>";
const PSEUDO_TOOL_KEYS = new Set([
  "analysis",
  "plan",
  "commands",
  "answer",
  "final",
  "response",
  "output",
  "result",
  "summary",
]);
const VISIBLE_KEYS = [
  "answer",
  "final",
  "response",
  "output",
  "result",
  "summary",
];
const THINKING_KEYS = ["analysis", "plan"];
const MAX_COMMAND_CHARS = 5000;

function cleanText(value: string): string {
  return value.replace(THINKING_TAG_RE, "").trim();
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return cleanText(value);
  if (value === undefined || value === null) return "";
  try {
    return cleanText(JSON.stringify(value, null, 2));
  } catch {
    return cleanText(String(value));
  }
}

function appendPart(parts: string[], label: string, value: unknown): void {
  const text = valueToText(value);
  if (!text) return;
  parts.push(`${label}:\n${text}`);
}

function parseObjectEnvelope(
  text: string,
): Record<string, unknown> | undefined {
  const trimmed = cleanText(text);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function hasPseudoToolShape(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => PSEUDO_TOOL_KEYS.has(key));
}

function likelyStreamingEnvelope(text: string): boolean {
  const trimmed = cleanText(text);
  if (!trimmed.startsWith("{") || trimmed.endsWith("}")) return false;
  return /"(analysis|plan|commands|answer|final|response|output)"\s*:/.test(
    trimmed,
  );
}

function formattedCommands(value: unknown): string {
  const text = valueToText(value);
  if (!text) return "";
  return text.length > MAX_COMMAND_CHARS
    ? `${text.slice(0, MAX_COMMAND_CHARS - 1)}...`
    : text;
}

function joinThinking(
  existing: string | undefined,
  extra: string,
): string | undefined {
  const current = existing?.trim() ?? "";
  const next = extra.trim();
  if (!next) return current || undefined;
  if (!current) return next;
  if (current.includes(next)) return current;
  return `${current}\n\n${next}`;
}

function normalizeNativeToolCallBlocks(
  text: string,
): NormalizedAgentMessage | undefined {
  if (!text.includes(TOOL_CALL_START)) return undefined;

  const visibleParts: string[] = [];
  const toolCalls: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf(TOOL_CALL_START, cursor);
    if (start < 0) {
      const trailing = valueToText(text.slice(cursor));
      if (trailing) visibleParts.push(trailing);
      break;
    }

    const leading = valueToText(text.slice(cursor, start));
    if (leading) visibleParts.push(leading);

    const bodyStart = start + TOOL_CALL_START.length;
    const end = text.indexOf(TOOL_CALL_END, bodyStart);
    if (end < 0) {
      const partial = valueToText(text.slice(bodyStart));
      if (partial) toolCalls.push(partial);
      break;
    }

    const body = valueToText(text.slice(bodyStart, end));
    if (body) toolCalls.push(body);
    cursor = end + TOOL_CALL_END.length;
  }

  visibleParts.push(
    [
      "Model produced native tool-call output, but Aethon did not execute it.",
      ...(toolCalls.length > 0
        ? ["", "```text", toolCalls.join("\n\n"), "```"]
        : []),
    ].join("\n"),
  );

  return { text: visibleParts.filter(Boolean).join("\n\n") };
}

export function normalizeAgentMessageForDisplay(
  message: Pick<ChatMessage, "role" | "text" | "thinking" | "a2ui">,
): NormalizedAgentMessage {
  if (message.role !== "agent" || message.a2ui || !message.text) {
    return { text: message.text, thinking: message.thinking };
  }

  const nativeToolCalls = normalizeNativeToolCallBlocks(message.text);
  if (nativeToolCalls) {
    return {
      text: nativeToolCalls.text,
      thinking: message.thinking,
    };
  }

  if (likelyStreamingEnvelope(message.text)) {
    return {
      text: "Model is emitting a structured tool-plan envelope. Waiting for the final answer...",
      thinking: message.thinking,
    };
  }

  const parsed = parseObjectEnvelope(message.text);
  if (!parsed || !hasPseudoToolShape(parsed)) {
    return { text: message.text, thinking: message.thinking };
  }

  const thinkingParts: string[] = [];
  for (const key of THINKING_KEYS) {
    appendPart(thinkingParts, key[0].toUpperCase() + key.slice(1), parsed[key]);
  }

  const visibleParts: string[] = [];
  for (const key of VISIBLE_KEYS) {
    const value = valueToText(parsed[key]);
    if (value) {
      visibleParts.push(value);
      break;
    }
  }

  const commands = formattedCommands(parsed.commands);
  if (commands) {
    visibleParts.push(
      [
        "Model produced proposed tool commands, but Aethon did not execute them.",
        "",
        "```json",
        commands,
        "```",
      ].join("\n"),
    );
  }

  if (visibleParts.length === 0) {
    visibleParts.push(
      "Model produced structured reasoning but did not provide a final answer.",
    );
  }

  return {
    text: visibleParts.join("\n\n"),
    thinking: joinThinking(message.thinking, thinkingParts.join("\n\n")),
  };
}

export function normalizeAgentMessage(message: ChatMessage): ChatMessage {
  const normalized = normalizeAgentMessageForDisplay(message);
  if (
    normalized.text === message.text &&
    normalized.thinking === message.thinking
  ) {
    return message;
  }
  return {
    ...message,
    text: normalized.text,
    thinking: normalized.thinking,
  };
}
