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
  trimText,
} from "./shared";

export function parseLocalChatLines(
  lines: Iterable<string>,
  expectedCwd?: string,
): RestoredChatMessage[] {
  const messages: RestoredChatMessage[] = [];
  const seen = new Map<string, number>();
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
    const a2ui = hasA2ui(record.a2ui) ? record.a2ui : undefined;
    if (!text && !thinking && !a2ui) continue;
    const id =
      typeof record.id === "string" && record.id.length > 0
        ? record.id
        : `aethon-local-${messages.length}`;
    const message = {
      id,
      role: record.role,
      ...(text ? { text } : {}),
      ...(thinking ? { thinking } : {}),
      ...(a2ui ? { a2ui } : {}),
      ...(typeof record.createdAt === "number"
        ? { createdAt: record.createdAt }
        : {}),
      ...(entryCwd ? { cwd: entryCwd } : {}),
    };
    const existingIndex = seen.get(id);
    if (existingIndex !== undefined) {
      messages[existingIndex] = message;
    } else {
      seen.set(id, messages.length);
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
