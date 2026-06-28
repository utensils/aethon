/**
 * Session metadata extraction: header cwd, first user message, latest
 * session log file, and the combined `readSessionMetadata` that the
 * sidebar uses to label rows.
 *
 * `latestSessionLog` is shared with `restore.ts` (read here, re-used
 * from the orchestration entry point), so it stays exported at module
 * scope rather than embedded in `readSessionMetadata`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  importLegacySessionDir,
  readSqliteSessionMetadata,
  sessionTabIdFromDir,
} from "../session-sqlite";
import { readSessionLabel } from "./io";
import {
  LOCAL_CHAT_FILE,
  type LatestSessionLog,
  MAX_LABEL_CHARS,
  type SessionLogMetadata,
  textFromContent,
} from "./shared";

function metaFromSessionLines(lines: Iterable<string>): {
  cwd?: string;
  firstUserMessage?: string;
} {
  let cwd: string | undefined;
  let firstUserMessage: string | undefined;

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

    if (!cwd && record.type === "session") {
      cwd =
        typeof record.cwd === "string" && record.cwd.length > 0
          ? record.cwd
          : undefined;
    }

    if (!firstUserMessage && record.type === "message") {
      const msg = record.message as Record<string, unknown> | undefined;
      if (msg?.role === "user") {
        const text = textFromContent(msg.content);
        if (text) {
          firstUserMessage =
            text.length > MAX_LABEL_CHARS
              ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…`
              : text;
        }
      }
    }

    if (cwd && firstUserMessage) break;
  }

  return { cwd, firstUserMessage };
}

export async function latestSessionLog(
  sessionDir: string,
): Promise<LatestSessionLog | null> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let latest: LatestSessionLog | null = null;
  for (const name of entries) {
    if (name === LOCAL_CHAT_FILE) continue;
    if (!name.endsWith(".jsonl")) continue;
    const path = join(sessionDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (
      !latest ||
      mtimeMs > latest.mtimeMs ||
      (mtimeMs === latest.mtimeMs && name > latest.name)
    ) {
      latest = { path, mtimeMs, name };
    }
  }
  return latest;
}

export async function readSessionMetadata(
  sessionDir: string,
): Promise<SessionLogMetadata | null> {
  importLegacySessionDir(sessionDir);
  const sqliteMeta = readSqliteSessionMetadata(sessionTabIdFromDir(sessionDir));
  if (sqliteMeta) return sqliteMeta;
  const latest = await latestSessionLog(sessionDir);
  if (!latest) return null;

  const raw = await readFile(latest.path, "utf8");
  const { cwd, firstUserMessage } = metaFromSessionLines(raw.split(/\r?\n/));
  const customLabel = await readSessionLabel(sessionDir);
  let cwdExists: boolean | undefined;
  if (cwd) {
    try {
      cwdExists = (await stat(cwd)).isDirectory();
    } catch {
      cwdExists = false;
    }
  }
  return {
    lastModified: latest.mtimeMs,
    ...(cwd ? { cwd, cwdExists } : {}),
    ...(firstUserMessage ? { firstUserMessage } : {}),
    ...(customLabel ? { customLabel } : {}),
  };
}
