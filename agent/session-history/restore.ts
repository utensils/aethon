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
import {
  MAX_RESTORED_MESSAGES,
  type RestoredChatAttachment,
  type RestoredChatMessage,
} from "./shared";

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

function attachmentKey(attachment: RestoredChatAttachment): string {
  return [
    attachment.kind,
    attachment.id,
    attachment.path,
    attachment.name,
    attachment.mimeType,
    attachment.sizeBytes,
  ].join("\0");
}

function mergeAttachments(
  base: RestoredChatMessage,
  additions: RestoredChatAttachment[],
): RestoredChatMessage {
  if (additions.length === 0) return base;
  const merged = [...(base.attachments ?? [])];
  const seen = new Set(merged.map(attachmentKey));
  for (const attachment of additions) {
    const key = attachmentKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(attachment);
  }
  return { ...base, attachments: merged };
}

function sameRestoredContent(
  piMessage: RestoredChatMessage,
  localMessage: RestoredChatMessage,
): boolean {
  if (piMessage.role !== localMessage.role) return false;
  const localParts = messageContentParts(localMessage);
  if (localParts.length === 0) return false;
  const piParts = new Map(messageContentParts(piMessage));
  return localParts.every(([channel, text]) => piParts.get(channel) === text);
}

function messageTimeDistance(
  piMessage: RestoredChatMessage,
  localMessage: RestoredChatMessage,
): number {
  if (
    typeof piMessage.createdAt !== "number" ||
    typeof localMessage.createdAt !== "number"
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(piMessage.createdAt - localMessage.createdAt);
}

function findPiMessageForLocalAttachments(
  piMessages: RestoredChatMessage[],
  localMessage: RestoredChatMessage,
): number {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < piMessages.length; index += 1) {
    const candidate = piMessages[index];
    if (!sameRestoredContent(candidate, localMessage)) continue;
    const distance = messageTimeDistance(candidate, localMessage);
    if (bestIndex < 0 || distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

function mergeLocalAttachmentsIntoPiMessages(
  piMessages: RestoredChatMessage[],
  localMessages: RestoredChatMessage[],
): RestoredChatMessage[] {
  let merged = piMessages;
  for (const localMessage of localMessages) {
    const attachments = localMessage.attachments ?? [];
    if (attachments.length === 0) continue;
    const index = findPiMessageForLocalAttachments(merged, localMessage);
    if (index < 0) continue;
    if (merged === piMessages) merged = [...piMessages];
    merged[index] = mergeAttachments(merged[index], attachments);
  }
  return merged;
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
  const mergedPiMessages = mergeLocalAttachmentsIntoPiMessages(
    piMessages,
    localMessages,
  );
  const localOnly = dedupeLocalMessages(mergedPiMessages, localMessages);
  return [...mergedPiMessages, ...localOnly].slice(-MAX_RESTORED_MESSAGES);
}
