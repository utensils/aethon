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
 * collisions (pi never replays the same id twice within a file).
 */

import { readFile } from "node:fs/promises";
import { latestSessionLog } from "./metadata";
import { findSessionFileMatchingCwd } from "./lookup";
import { readLocalChatTranscript } from "./parse-local";
import { parseSessionHistoryLines } from "./parse-pi";
import { MAX_RESTORED_MESSAGES, type RestoredChatMessage } from "./shared";

function comparableMessageText(
  message: RestoredChatMessage,
): string | undefined {
  const value = message.text ?? message.thinking;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function dedupeLocalMessages(
  piMessages: RestoredChatMessage[],
  localMessages: RestoredChatMessage[],
): RestoredChatMessage[] {
  const seenIds = new Set(piMessages.map((message) => message.id));
  const seenContent = new Set(
    piMessages
      .map((message) => {
        const text = comparableMessageText(message);
        return text ? `${message.role}\0${text}` : undefined;
      })
      .filter((value): value is string => Boolean(value)),
  );
  return localMessages.filter((message) => {
    if (seenIds.has(message.id)) return false;
    const text = comparableMessageText(message);
    if (!text) return true;
    return !seenContent.has(`${message.role}\0${text}`);
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
