/**
 * Aethon-local chat append-log parser. Reads `aethon-chat.jsonl` (the
 * append-only file appended by the bridge for messages pi doesn't see —
 * UI events, A2UI canvases, slash overlays) and returns matching
 * RestoredChatMessage entries.
 *
 * When `expectedCwd` is supplied, only messages whose `cwd` field
 * matches are returned — protects against the shared `default` tab
 * leaking one project's local history into another.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LOCAL_CHAT_FILE,
  type RestoredChatMessage,
  hasA2ui,
  isChatRole,
  normalizeCwd,
  parseChatAttachments,
  toolCardRecordsFromA2ui,
  trimText,
} from "./shared";

function toolCardDedupeKeys(message: RestoredChatMessage): string[] {
  return toolCardRecordsFromA2ui(message.a2ui).map(
    (record) => `${record.identity}\0${record.startedAt ?? ""}`,
  );
}

function clearSeenToolCardKeys(
  seenToolCards: Map<string, number>,
  message: RestoredChatMessage,
  index: number,
): void {
  for (const key of toolCardDedupeKeys(message)) {
    if (seenToolCards.get(key) === index) seenToolCards.delete(key);
  }
}

function rememberToolCardKeys(
  seenToolCards: Map<string, number>,
  message: RestoredChatMessage,
  index: number,
): void {
  for (const key of toolCardDedupeKeys(message)) {
    seenToolCards.set(key, index);
  }
}

function firstSeenToolCardIndex(
  seenToolCards: ReadonlyMap<string, number>,
  message: RestoredChatMessage,
): number | undefined {
  for (const key of toolCardDedupeKeys(message)) {
    const index = seenToolCards.get(key);
    if (index !== undefined) return index;
  }
  return undefined;
}

export function parseLocalChatLines(
  lines: Iterable<string>,
  expectedCwd?: string,
): RestoredChatMessage[] {
  const messages: RestoredChatMessage[] = [];
  const seen = new Map<string, number>();
  const seenToolCards = new Map<string, number>();
  const targetCwd = normalizeCwd(expectedCwd);
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
    if (record.type !== "aethon_chat") continue;
    if (!isChatRole(record.role)) continue;
    const entryCwd =
      typeof record.cwd === "string" && record.cwd.length > 0
        ? record.cwd
        : undefined;
    if (targetCwd !== undefined && normalizeCwd(entryCwd) !== targetCwd) {
      continue;
    }
    const text = typeof record.text === "string" ? trimText(record.text) : "";
    const thinking =
      typeof record.thinking === "string" ? trimText(record.thinking) : "";
    const attachments = parseChatAttachments(record.attachments);
    const a2ui = hasA2ui(record.a2ui) ? record.a2ui : undefined;
    if (!text && !thinking && !a2ui && attachments.length === 0) continue;
    const id =
      typeof record.id === "string" && record.id.length > 0
        ? record.id
        : `aethon-local-${messages.length}`;
    const message = {
      id,
      role: record.role,
      ...(text ? { text } : {}),
      ...(thinking ? { thinking } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(a2ui ? { a2ui } : {}),
      ...(typeof record.createdAt === "number"
        ? { createdAt: record.createdAt }
        : {}),
      ...(entryCwd ? { cwd: entryCwd } : {}),
    };
    const existingIndex =
      seen.get(id) ?? firstSeenToolCardIndex(seenToolCards, message);
    if (existingIndex !== undefined) {
      const previous = messages[existingIndex];
      seen.delete(previous.id);
      clearSeenToolCardKeys(seenToolCards, previous, existingIndex);
      messages[existingIndex] = message;
      seen.set(id, existingIndex);
      rememberToolCardKeys(seenToolCards, message, existingIndex);
    } else {
      seen.set(id, messages.length);
      rememberToolCardKeys(seenToolCards, message, messages.length);
      messages.push(message);
    }
  }
  return messages;
}

export async function readLocalChatTranscript(
  sessionDir: string,
  expectedCwd?: string,
): Promise<RestoredChatMessage[]> {
  try {
    const raw = await readFile(join(sessionDir, LOCAL_CHAT_FILE), "utf8");
    return parseLocalChatLines(raw.split(/\r?\n/), expectedCwd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}
