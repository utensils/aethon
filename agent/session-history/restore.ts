/**
 * Top-level restore orchestration. Combines:
 *  - Pi session-file parsing (via `parse-pi.ts`)
 *  - Aethon local-chat parsing (via `parse-local.ts`)
 *  - cwd-scoped file selection (via `lookup.ts`) for the shared
 *    `default` tab
 *  - latest-mtime fallback (via `metadata.ts`) for project-private
 *    UUID-keyed restored tabs
 *  - Dedup of local-chat entries already covered by pi messages
 *
 * The dedupe runs only on local-chat entries to avoid pi-on-pi
 * collisions (pi never replays the same id twice within a file). Assistant
 * local content is also considered covered when it is a slice of canonical
 * pi text/thinking, which filters streaming snapshots from completed turns.
 */

import { readFile } from "node:fs/promises";
import { latestSessionLog } from "./metadata";
import { findSessionFileMatchingCwd } from "./lookup";
import { readLocalChatTranscript } from "./parse-local";
import { parseSessionHistoryLines } from "./parse-pi";
import { MAX_RESTORED_MESSAGES, type RestoredChatMessage } from "./shared";

type ContentChannel = "text" | "thinking";

function normalizedMessageText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function messageContentParts(
  message: RestoredChatMessage,
): Array<[ContentChannel, string]> {
  const parts: Array<[ContentChannel, string]> = [];
  const text = normalizedMessageText(message.text);
  if (text) parts.push(["text", text]);
  const thinking = normalizedMessageText(message.thinking);
  if (thinking) parts.push(["thinking", thinking]);
  return parts;
}

interface IndexedPiContent {
  text: string;
  createdAt?: number;
}

function piContentIndex(
  piMessages: RestoredChatMessage[],
): Map<string, IndexedPiContent[]> {
  const index = new Map<string, IndexedPiContent[]>();
  for (const message of piMessages) {
    for (const [channel, text] of messageContentParts(message)) {
      const key = `${message.role}\0${channel}`;
      const existing = index.get(key);
      const entry = {
        text,
        ...(typeof message.createdAt === "number"
          ? { createdAt: message.createdAt }
          : {}),
      };
      if (existing) existing.push(entry);
      else index.set(key, [entry]);
    }
  }
  return index;
}

function isCoveredByPiContent(
  message: RestoredChatMessage,
  index: ReadonlyMap<string, IndexedPiContent[]>,
): boolean {
  const parts = messageContentParts(message);
  if (parts.length === 0) return false;
  return parts.every(([channel, text]) => {
    const candidates = index.get(`${message.role}\0${channel}`) ?? [];
    return candidates.some((candidate) => {
      if (candidate.text === text) return true;
      // Partial local agent snapshots are only safe to drop when they are
      // timestamped streaming snapshots that were later finalized into a pi
      // assistant message. A global substring match against older pi content
      // can otherwise erase unrelated stopped/crashed-turn snapshots.
      return (
        message.role === "agent" &&
        message.id.startsWith("text-") &&
        typeof message.createdAt === "number" &&
        typeof candidate.createdAt === "number" &&
        message.createdAt <= candidate.createdAt &&
        candidate.text.includes(text)
      );
    });
  });
}

function dedupeLocalMessages(
  piMessages: RestoredChatMessage[],
  localMessages: RestoredChatMessage[],
): RestoredChatMessage[] {
  const seenIds = new Set(piMessages.map((message) => message.id));
  const contentIndex = piContentIndex(piMessages);
  return localMessages.filter((message) => {
    if (seenIds.has(message.id)) return false;
    return !isCoveredByPiContent(message, contentIndex);
  });
}

export async function readSessionTranscript(
  sessionDir: string,
  expectedCwd?: string,
): Promise<RestoredChatMessage[]> {
  // When `expectedCwd` is provided, only restore from a session whose
  // header cwd matches — the shared `default` tab dir collects sessions
  // from every project the user worked in, and the latest by mtime can
  // belong to a different project than the one currently active. The
  // unscoped path (no expectedCwd) keeps the prior behaviour for callers
  // that already know the dir maps 1:1 to the requested context (e.g.
  // UUID-keyed restored tabs whose dir is project-private by construction).
  let path: string | undefined;
  if (expectedCwd !== undefined) {
    path = await findSessionFileMatchingCwd(sessionDir, expectedCwd);
  } else {
    path = (await latestSessionLog(sessionDir))?.path;
  }
  const localMessages = await readLocalChatTranscript(sessionDir, expectedCwd);
  if (!path) return localMessages.slice(-MAX_RESTORED_MESSAGES);

  const raw = await readFile(path, "utf8");
  const piMessages = parseSessionHistoryLines(raw.split(/\r?\n/));
  const localOnly = dedupeLocalMessages(piMessages, localMessages);
  return [...piMessages, ...localOnly].slice(-MAX_RESTORED_MESSAGES);
}
