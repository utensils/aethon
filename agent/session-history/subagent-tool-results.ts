import { appendFile, readFile } from "node:fs/promises";

export const SUBAGENT_TOOL_NAMES = new Set(["task", "task_batch"]);

export interface DanglingSubagentToolCall {
  toolCallId: string;
  toolName: string;
}

export interface SyntheticSubagentToolResult {
  toolCallId: string;
  toolName: string;
  partialText?: string;
}

interface SessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  message?: Record<string, unknown>;
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 96) || "tool";
}

export function isSubagentToolName(
  value: unknown,
): value is "task" | "task_batch" {
  return typeof value === "string" && SUBAGENT_TOOL_NAMES.has(value);
}

export function syntheticSubagentCancellationText(
  toolName: string,
  partialText?: string,
): string {
  const label = toolName === "task_batch" ? "task_batch" : "task";
  const base = `Aethon interrupted the inline ${label} subagent delegation before a tool result was delivered to the parent agent. Treat this delegation as cancelled/failed and continue with an alternate plan.`;
  const partial = partialText?.trim();
  if (!partial) return base;
  return `${base}\n\nPartial output before interruption:\n\n${partial}`;
}

export function syntheticSubagentToolResultMessage(
  result: SyntheticSubagentToolResult,
  timestamp: number | string = Date.now(),
): Record<string, unknown> {
  return {
    role: "toolResult",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    content: [
      {
        type: "text",
        text: syntheticSubagentCancellationText(
          result.toolName,
          result.partialText,
        ),
      },
    ],
    isError: true,
    timestamp,
  };
}

export function syntheticSubagentToolResultRecord(
  result: SyntheticSubagentToolResult,
  timestamp = Date.now(),
  index = 0,
  parentId?: string,
): Record<string, unknown> {
  return {
    type: "message",
    id: `aethon-synthetic-tool-result-${safeIdPart(
      result.toolCallId,
    )}-${timestamp}-${index}`,
    ...(parentId ? { parentId } : {}),
    timestamp,
    message: syntheticSubagentToolResultMessage(result, timestamp),
  };
}

export function findDanglingSubagentToolCalls(
  lines: Iterable<string>,
): DanglingSubagentToolCall[] {
  const calls = new Map<string, DanglingSubagentToolCall>();
  const completed = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;

    if (msg.role === "toolResult") {
      if (typeof msg.toolCallId === "string" && msg.toolCallId.length > 0) {
        completed.add(msg.toolCallId);
        calls.delete(msg.toolCallId);
      }
      continue;
    }

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      const toolCall = part as Record<string, unknown>;
      if (toolCall.type !== "toolCall") continue;
      if (!isSubagentToolName(toolCall.name)) continue;
      const toolCallId =
        typeof toolCall.id === "string" && toolCall.id.length > 0
          ? toolCall.id
          : undefined;
      if (!toolCallId || completed.has(toolCallId)) continue;
      calls.set(toolCallId, {
        toolCallId,
        toolName: toolCall.name,
      });
    }
  }

  return [...calls.values()];
}

function latestSessionEntryId(lines: Iterable<string>): string | undefined {
  let latest: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (record.type === "session") continue;
    if (typeof record.id === "string" && record.id.length > 0) {
      latest = record.id;
    }
  }
  return latest;
}

export async function appendSyntheticSubagentToolResults(
  sessionFile: string,
  results: SyntheticSubagentToolResult[],
): Promise<number> {
  if (results.length === 0) return 0;
  const raw = await readFile(sessionFile, "utf8").catch(() => "");
  const timestamp = Date.now();
  let parentId = latestSessionEntryId(raw.split(/\r?\n/));
  const records = results.map((result, index) => {
    const record = syntheticSubagentToolResultRecord(
      result,
      timestamp,
      index,
      parentId,
    );
    parentId = typeof record.id === "string" ? record.id : parentId;
    return record;
  });
  const payload = records.map((record) => JSON.stringify(record)).join("\n");
  await appendFile(sessionFile, `${payload}\n`, "utf8");
  return results.length;
}

function parseSessionEntries(lines: Iterable<string>): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (record.type === "session") continue;
    entries.push(record);
  }
  return entries;
}

function activeBranch(entries: readonly SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  let leafId: string | undefined;
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    byId.set(entry.id, entry);
    leafId = entry.id;
  }
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  let current = leafId ? byId.get(leafId) : undefined;
  while (current) {
    const id = current.id;
    if (typeof id !== "string" || seen.has(id)) break;
    seen.add(id);
    branch.unshift(current);
    const parentId =
      typeof current.parentId === "string" && current.parentId.length > 0
        ? current.parentId
        : undefined;
    current = parentId ? byId.get(parentId) : undefined;
  }
  return branch;
}

function contentToolCalls(message: Record<string, unknown>): Array<{
  id: string;
  name: string;
}> {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const toolCall = part as Record<string, unknown>;
    if (toolCall.type !== "toolCall") return [];
    if (!isSubagentToolName(toolCall.name)) return [];
    if (typeof toolCall.id !== "string" || toolCall.id.length === 0) return [];
    return [{ id: toolCall.id, name: toolCall.name }];
  });
}

function hasLaterConversationMessage(
  branch: readonly SessionEntry[],
  index: number,
): boolean {
  return branch.slice(index + 1).some((entry) => {
    const role = entry.message?.role;
    return role === "user" || role === "assistant";
  });
}

function findDanglingSubagentToolCallsInActiveBranch(
  lines: Iterable<string>,
): DanglingSubagentToolCall[] {
  const branch = activeBranch(parseSessionEntries(lines));
  const completed = new Set<string>();
  const calls = new Map<string, DanglingSubagentToolCall>();
  for (let index = 0; index < branch.length; index += 1) {
    const msg = branch[index]?.message;
    if (!msg) continue;
    if (msg.role === "toolResult") {
      if (typeof msg.toolCallId === "string" && msg.toolCallId.length > 0) {
        completed.add(msg.toolCallId);
        calls.delete(msg.toolCallId);
      }
      continue;
    }
    if (msg.role !== "assistant") continue;
    if (hasLaterConversationMessage(branch, index)) continue;
    for (const toolCall of contentToolCalls(msg)) {
      if (!completed.has(toolCall.id)) {
        calls.set(toolCall.id, {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });
      }
    }
  }
  return [...calls.values()];
}

export async function repairDanglingSubagentToolResults(
  sessionFile: string,
): Promise<number> {
  const raw = await readFile(sessionFile, "utf8");
  const dangling = findDanglingSubagentToolCallsInActiveBranch(
    raw.split(/\r?\n/),
  );
  return appendSyntheticSubagentToolResults(sessionFile, dangling);
}
