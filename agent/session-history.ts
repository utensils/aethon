import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const LABEL_FILE = "label.txt";
const LOCAL_CHAT_FILE = "aethon-chat.jsonl";
const MAX_CUSTOM_LABEL_CHARS = 120;

export function normalizeSessionLabel(label: string): string {
  return label.trim().slice(0, MAX_CUSTOM_LABEL_CHARS);
}

/** Per-session custom label set via the sidebar "Rename session…"
 *  context-menu action. Returns undefined if no label has been set
 *  (or if the file can't be read — best-effort, never throws). */
export async function readSessionLabel(
  sessionDir: string,
): Promise<string | undefined> {
  try {
    const text = await readFile(join(sessionDir, LABEL_FILE), "utf8");
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    return trimmed.length > MAX_CUSTOM_LABEL_CHARS
      ? trimmed.slice(0, MAX_CUSTOM_LABEL_CHARS)
      : trimmed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

/** Write a custom label for the given session. Empty / whitespace-only
 *  input clears the label (deletes the file). The session dir is
 *  created if missing so the call is safe before any chat turn. */
export async function writeSessionLabel(
  sessionDir: string,
  label: string,
): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  const trimmed = normalizeSessionLabel(label);
  const path = join(sessionDir, LABEL_FILE);
  if (!trimmed) {
    try {
      const fs = await import("node:fs/promises");
      await fs.unlink(path);
    } catch {
      // Already absent — the desired end state.
    }
    return;
  }
  await writeFile(path, trimmed + "\n", "utf8");
}

const MAX_RESTORED_MESSAGES = 200;
const MAX_LOCAL_CHAT_MESSAGES = 400;
const MAX_TEXT_CHARS = 8 * 1024;

export interface RestoredChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  text?: string;
  thinking?: string;
  createdAt?: number;
  cwd?: string;
}

interface LatestSessionLog {
  path: string;
  mtimeMs: number;
  name: string;
}

export interface SessionLogMetadata {
  cwd?: string;
  lastModified: number;
  /** First user-turn text, trimmed to 60 chars. Used to label sessions
   *  meaningfully in the sidebar instead of showing raw UUID slices. */
  firstUserMessage?: string;
  /** User-supplied label (sidebar "Rename session…" / `/rename`).
   *  Wins over `firstUserMessage` when both are present. */
  customLabel?: string;
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

function isChatRole(role: unknown): role is RestoredChatMessage["role"] {
  return role === "user" || role === "agent" || role === "system";
}

export async function appendLocalChatMessage(
  sessionDir: string,
  message: RestoredChatMessage,
): Promise<void> {
  if (!isChatRole(message.role)) return;
  const text = typeof message.text === "string" ? trimText(message.text) : "";
  const thinking =
    typeof message.thinking === "string" ? trimText(message.thinking) : "";
  if (!text && !thinking) return;
  await mkdir(sessionDir, { recursive: true });
  const entry = {
    type: "aethon_chat",
    id: message.id || randomUUID(),
    role: message.role,
    ...(text ? { text } : {}),
    ...(thinking ? { thinking } : {}),
    createdAt:
      typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
        ? message.createdAt
        : Date.now(),
    ...(typeof message.cwd === "string" && message.cwd.length > 0
      ? { cwd: message.cwd }
      : {}),
  };
  const path = join(sessionDir, LOCAL_CHAT_FILE);
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  await pruneLocalChatFile(path);
}

function normalizeCwd(cwd: string | undefined): string | undefined {
  return cwd?.replace(/[/\\]+$/, "");
}

function parseLocalChatLines(
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
    if (!text && !thinking) continue;
    const id =
      typeof record.id === "string" && record.id.length > 0
        ? record.id
        : `aethon-local-${messages.length}`;
    const message = {
      id,
      role: record.role,
      ...(text ? { text } : {}),
      ...(thinking ? { thinking } : {}),
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

async function readLocalChatTranscript(
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

async function pruneLocalChatFile(path: string): Promise<void> {
  try {
    const raw = await readFile(path, "utf8");
    const kept = parseLocalChatLines(raw.split(/\r?\n/)).slice(
      -MAX_LOCAL_CHAT_MESSAGES,
    );
    const next = kept
      .map((m) =>
        JSON.stringify({
          type: "aethon_chat",
          id: m.id,
          role: m.role,
          ...(m.text ? { text: m.text } : {}),
          ...(m.thinking ? { thinking: m.thinking } : {}),
          ...(typeof m.createdAt === "number" ? { createdAt: m.createdAt } : {}),
          ...(m.cwd ? { cwd: m.cwd } : {}),
        }),
      )
      .join("\n");
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, next ? `${next}\n` : "", "utf8");
    await rename(tempPath, path);
  } catch {
    /* best effort */
  }
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

function comparableMessageText(message: RestoredChatMessage): string | undefined {
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

async function readSessionHeaderCwd(path: string): Promise<string | undefined> {
  // The session header (`{type:"session", cwd: "..."}`) is always the
  // first line of the .jsonl. Read just enough to parse it — full-file
  // reads add up when this is called for every file in a session dir.
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const newline = raw.indexOf("\n");
  const firstLine = (newline === -1 ? raw : raw.slice(0, newline)).trim();
  if (!firstLine) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(firstLine);
  } catch {
    return undefined;
  }
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  if (record.type !== "session") return undefined;
  return typeof record.cwd === "string" && record.cwd.length > 0
    ? record.cwd
    : undefined;
}

/**
 * Find the most-recently-modified `.jsonl` session file in `sessionDir`
 * whose header `cwd` matches `expectedCwd`. Returns the absolute path,
 * or `undefined` when no matching file exists.
 *
 * Used by `ensureTab` to resume the right project's session for the
 * shared `default` tab id — a project-agnostic `continueRecent` would
 * pick whichever session was touched last regardless of project, which
 * leaks one project's chat into another on cold start.
 *
 * Trailing slashes on the cwd are normalised; case-sensitivity follows
 * the host filesystem (we only compare strings — pi's session header
 * stores whatever `process.cwd()` returned, so an exact match is fine
 * on the platforms we ship).
 */
export async function findSessionFileMatchingCwd(
  sessionDir: string,
  expectedCwd: string,
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
  const target = expectedCwd.replace(/[/\\]+$/, "");
  const matches: LatestSessionLog[] = [];
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
    const cwd = await readSessionHeaderCwd(path);
    if (!cwd) continue;
    if (cwd.replace(/[/\\]+$/, "") !== target) continue;
    matches.push({ path, mtimeMs, name });
  }
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.name.localeCompare(a.name);
  });
  return matches[0].path;
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

const MAX_LABEL_CHARS = 60;

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

export async function readSessionMetadata(
  sessionDir: string,
): Promise<SessionLogMetadata | null> {
  const latest = await latestSessionLog(sessionDir);
  if (!latest) return null;

  const raw = await readFile(latest.path, "utf8");
  const { cwd, firstUserMessage } = metaFromSessionLines(raw.split(/\r?\n/));
  const customLabel = await readSessionLabel(sessionDir);
  return {
    lastModified: latest.mtimeMs,
    ...(cwd ? { cwd } : {}),
    ...(firstUserMessage ? { firstUserMessage } : {}),
    ...(customLabel ? { customLabel } : {}),
  };
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
