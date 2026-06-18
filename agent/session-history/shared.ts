/**
 * Shared types, constants, and pure helpers for session-history.
 * Every submodule imports from here; no submodule imports from another
 * (parse, normalize, dedupe, io, metadata, lookup) imports another via
 * this shared module to avoid circular paths.
 */

export const LABEL_FILE = "label.txt";
export const LOCAL_CHAT_FILE = "aethon-chat.jsonl";
export const MAX_CUSTOM_LABEL_CHARS = 120;
export const MAX_RESTORED_MESSAGES = 200;
export const MAX_LOCAL_CHAT_MESSAGES = 400;
export const MAX_TEXT_CHARS = 8 * 1024;
export const MAX_LABEL_CHARS = 60;

export interface RestoredChatMessage {
  id: string;
  /** pi session entry id (8-char hex) for user/assistant turns — the handle
   *  `SessionManager.branch()` / `createBranchedSession()` need for rollback /
   *  fork. Absent on tool-card and system rows (you don't branch to those). */
  entryId?: string;
  role: "user" | "agent" | "system";
  text?: string;
  thinking?: string;
  attachments?: RestoredChatAttachment[];
  a2ui?: { components: unknown[] };
  createdAt?: number;
  cwd?: string;
}

export interface RestoredChatAttachment {
  id: string;
  kind: "image";
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface LatestSessionLog {
  path: string;
  mtimeMs: number;
  name: string;
}

export interface SessionLogMetadata {
  cwd?: string;
  /** false when `cwd` is set but the directory no longer exists on disk
   *  (e.g. a deleted workspace/worktree). Absent when cwd is unset. */
  cwdExists?: boolean;
  lastModified: number;
  /** First user-turn text, trimmed to 60 chars. Used to label sessions
   *  meaningfully in the sidebar instead of showing raw UUID slices. */
  firstUserMessage?: string;
  /** User-supplied label (sidebar "Rename session…" / `/rename`).
   *  Wins over `firstUserMessage` when both are present. */
  customLabel?: string;
}

export function isChatRole(role: unknown): role is RestoredChatMessage["role"] {
  return role === "user" || role === "agent" || role === "system";
}

export function hasA2ui(value: unknown): value is { components: unknown[] } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { components?: unknown }).components)
  );
}

export function parseChatAttachments(value: unknown): RestoredChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      record.kind !== "image" ||
      typeof record.path !== "string" ||
      typeof record.name !== "string" ||
      typeof record.mimeType !== "string" ||
      !record.mimeType.startsWith("image/") ||
      typeof record.sizeBytes !== "number" ||
      !Number.isFinite(record.sizeBytes)
    ) {
      return [];
    }
    return [
      {
        id: record.id,
        kind: "image",
        path: record.path,
        name: record.name,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
      },
    ];
  });
}

export function trimText(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS - 3)}...`
    : text;
}

/** Strip trailing slashes so saved-cwd strings compare structurally. */
export function normalizeCwd(cwd: string | undefined): string | undefined {
  return cwd?.replace(/[/\\]+$/, "");
}

/** Extract text content from a pi message body. Accepts a raw string or
 *  the typed-block content array used by the Anthropic format. */
export function textFromContent(content: unknown): string {
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

/** Extract thinking / reasoning text from a pi message body (assistant
 *  turns only — user turns never carry these blocks). */
export function thinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "thinking" && typeof record.thinking === "string") {
      chunks.push(record.thinking);
    } else if (
      (record.type === "thinking" || record.type === "reasoning") &&
      typeof record.text === "string"
    ) {
      chunks.push(record.text);
    }
  }
  return chunks.join("\n").trim();
}
