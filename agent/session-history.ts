import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_RESTORED_MESSAGES = 200;
const MAX_TEXT_CHARS = 8 * 1024;

export interface RestoredChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  text?: string;
}

interface LatestSessionLog {
  path: string;
  mtimeMs: number;
  name: string;
}

export interface SessionLogMetadata {
  cwd?: string;
  lastModified: number;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      chunks.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      chunks.push(record.text);
    }
  }
  return chunks.join("\n").trim();
}

function trimText(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS - 3)}...`
    : text;
}

export function parseSessionHistoryLines(lines: Iterable<string>): RestoredChatMessage[] {
  const messages: RestoredChatMessage[] = [];
  const seen = new Set<string>();

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
    if (record.type !== "message") continue;

    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    const sourceRole = msg.role;
    const role =
      sourceRole === "user"
        ? "user"
        : sourceRole === "assistant"
          ? "agent"
          : null;
    if (!role) continue;

    const text = textFromContent(msg.content);
    if (!text) continue;

    const id =
      typeof record.id === "string" && record.id.length > 0
        ? record.id
        : `restored-${messages.length}`;
    if (seen.has(id)) continue;
    seen.add(id);

    messages.push({ id, role, text: trimText(text) });
  }

  return messages.slice(-MAX_RESTORED_MESSAGES);
}

async function latestSessionLog(sessionDir: string): Promise<LatestSessionLog | null> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let latest: LatestSessionLog | null = null;
  for (const name of entries) {
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

function cwdFromSessionLines(lines: Iterable<string>): string | undefined {
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
    if (record.type !== "session") continue;
    return typeof record.cwd === "string" && record.cwd.length > 0
      ? record.cwd
      : undefined;
  }
  return undefined;
}

export async function readSessionMetadata(
  sessionDir: string,
): Promise<SessionLogMetadata | null> {
  const latest = await latestSessionLog(sessionDir);
  if (!latest) return null;

  const raw = await readFile(latest.path, "utf8");
  const cwd = cwdFromSessionLines(raw.split(/\r?\n/));
  return {
    lastModified: latest.mtimeMs,
    ...(cwd ? { cwd } : {}),
  };
}

export async function readSessionTranscript(
  sessionDir: string,
): Promise<RestoredChatMessage[]> {
  const latest = await latestSessionLog(sessionDir);
  if (!latest) return [];

  const raw = await readFile(latest.path, "utf8");
  return parseSessionHistoryLines(raw.split(/\r?\n/));
}
