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

function normalizeToolCallId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 96);
}

function toolCardIdentityFromId(id: string): string | undefined {
  if (id.startsWith("restored-tool-")) {
    return id.slice("restored-tool-".length);
  }
  const liveMatch = /^tool-\d+-(.+)$/.exec(id);
  if (liveMatch) return normalizeToolCallId(liveMatch[1]);
  return undefined;
}

function toolCardRecords(
  message: RestoredChatMessage,
): Array<{ identity: string; status?: unknown }> {
  const components = message.a2ui?.components ?? [];
  const records: Array<{ identity: string; status?: unknown }> = [];
  for (const component of components) {
    if (!component || typeof component !== "object") continue;
    const record = component as Record<string, unknown>;
    if (record.type !== "tool-card" || typeof record.id !== "string") {
      continue;
    }
    const identity = toolCardIdentityFromId(record.id);
    if (!identity) continue;
    const props =
      record.props && typeof record.props === "object"
        ? (record.props as Record<string, unknown>)
        : undefined;
    records.push({ identity, status: props?.status });
  }
  return records;
}

function toolCardIdentities(message: RestoredChatMessage): string[] {
  return toolCardRecords(message).map((record) => record.identity);
}

function piToolCardIdentitySet(piMessages: RestoredChatMessage[]): Set<string> {
  const identities = new Set<string>();
  for (const message of piMessages) {
    for (const identity of toolCardIdentities(message))
      identities.add(identity);
  }
  return identities;
}

function isCancelledToolCardMessage(message: RestoredChatMessage): boolean {
  const records = toolCardRecords(message);
  return (
    records.length > 0 &&
    records.some((record) => record.status === "cancelled")
  );
}

function cancelledToolCardIdentitySet(
  messages: RestoredChatMessage[],
): Set<string> {
  const identities = new Set<string>();
  for (const message of messages) {
    for (const record of toolCardRecords(message)) {
      if (record.status === "cancelled") identities.add(record.identity);
    }
  }
  return identities;
}

function isCoveredByPiToolCard(
  message: RestoredChatMessage,
  piToolCards: ReadonlySet<string>,
): boolean {
  if (isCancelledToolCardMessage(message)) return false;
  const identities = toolCardIdentities(message);
  return (
    identities.length > 0 &&
    identities.every((identity) => piToolCards.has(identity))
  );
}

function removePiToolCardsCoveredByLocalCancellation(
  piMessages: RestoredChatMessage[],
  localMessages: RestoredChatMessage[],
): RestoredChatMessage[] {
  const cancelledIdentities = cancelledToolCardIdentitySet(localMessages);
  if (cancelledIdentities.size === 0) return piMessages;
  return piMessages.filter((message) => {
    const identities = toolCardIdentities(message);
    return (
      identities.length === 0 ||
      !identities.every((identity) => cancelledIdentities.has(identity))
    );
  });
}

function isCompactionMarker(message: RestoredChatMessage): boolean {
  if (message.role !== "system" || typeof message.text !== "string") {
    return false;
  }
  const text = message.text.replace(/\s+/g, " ").trim().toLowerCase();
  return (
    text === "compacting context..." ||
    text === "compacting context…" ||
    text.startsWith("context compacted") ||
    text.startsWith("context compaction complete") ||
    text.startsWith("context compaction failed:")
  );
}

function piCompactionMarkers(
  piMessages: RestoredChatMessage[],
): RestoredChatMessage[] {
  return piMessages.filter(
    (message) =>
      message.id.startsWith("compaction:") && isCompactionMarker(message),
  );
}

function isCoveredByPiCompaction(
  message: RestoredChatMessage,
  piCompactions: readonly RestoredChatMessage[],
): boolean {
  if (!isCompactionMarker(message) || piCompactions.length === 0) return false;
  if (typeof message.createdAt !== "number") {
    return piCompactions.some((candidate) => candidate.text === message.text);
  }
  return piCompactions.some(
    (candidate) =>
      typeof candidate.createdAt === "number" &&
      Math.abs(candidate.createdAt - message.createdAt) <= 5 * 60 * 1000,
  );
}

function dedupeLocalMessages(
  piMessages: RestoredChatMessage[],
  localMessages: RestoredChatMessage[],
): RestoredChatMessage[] {
  const seenIds = new Set(piMessages.map((message) => message.id));
  const contentIndex = piContentIndex(piMessages);
  const piToolCards = piToolCardIdentitySet(piMessages);
  const piCompactions = piCompactionMarkers(piMessages);
  return localMessages.filter((message) => {
    if (seenIds.has(message.id)) return false;
    if (isCoveredByPiCompaction(message, piCompactions)) return false;
    if (isCoveredByPiToolCard(message, piToolCards)) return false;
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

function mergeRestoredMessagesChronologically(
  piMessages: RestoredChatMessage[],
  localMessages: RestoredChatMessage[],
): RestoredChatMessage[] {
  return [
    ...piMessages.map((message, order) => ({ message, order })),
    ...localMessages.map((message, offset) => ({
      message,
      order: piMessages.length + offset,
    })),
  ]
    .sort((a, b) => {
      const aTime = a.message.createdAt;
      const bTime = b.message.createdAt;
      if (
        typeof aTime === "number" &&
        typeof bTime === "number" &&
        aTime !== bTime
      ) {
        return aTime - bTime;
      }
      return a.order - b.order;
    })
    .map((entry) => entry.message);
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
  const piMessages = removePiToolCardsCoveredByLocalCancellation(
    parseSessionHistoryLines(raw.split(/\r?\n/)),
    localMessages,
  );
  const mergedPiMessages = mergeLocalAttachmentsIntoPiMessages(
    piMessages,
    localMessages,
  );
  const localOnly = dedupeLocalMessages(mergedPiMessages, localMessages);
  return mergeRestoredMessagesChronologically(
    mergedPiMessages,
    localOnly,
  ).slice(-MAX_RESTORED_MESSAGES);
}
