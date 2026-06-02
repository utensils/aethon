/**
 * File-system layer for session-history: label read/write, local-chat
 * append (with atomic prune), and the leaf-file conventions the rest
 * of the module assumes (`label.txt`, `aethon-chat.jsonl`).
 *
 * Atomic write contract for `pruneLocalChatFile`: write to a
 * temp-named file under the same directory, then `rename` over the
 * destination. The temp filename is `<basename>.<pid>.<uuid>.tmp` so
 * concurrent agent instances don't collide.
 */

import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { parseLocalChatLines } from "./parse-local";
import {
  LABEL_FILE,
  LOCAL_CHAT_FILE,
  MAX_CUSTOM_LABEL_CHARS,
  MAX_LOCAL_CHAT_MESSAGES,
  type RestoredChatMessage,
  hasA2ui,
  isChatRole,
  parseChatAttachments,
  trimText,
} from "./shared";

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

export async function appendLocalChatMessage(
  sessionDir: string,
  message: RestoredChatMessage,
): Promise<void> {
  if (!isChatRole(message.role)) return;
  const text = typeof message.text === "string" ? trimText(message.text) : "";
  const thinking =
    typeof message.thinking === "string" ? trimText(message.thinking) : "";
  const attachments = parseChatAttachments(message.attachments);
  const a2ui = hasA2ui(message.a2ui) ? message.a2ui : undefined;
  if (!text && !thinking && !a2ui && attachments.length === 0) return;
  await mkdir(sessionDir, { recursive: true });
  const entry = {
    type: "aethon_chat",
    id: message.id || randomUUID(),
    role: message.role,
    ...(text ? { text } : {}),
    ...(thinking ? { thinking } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(a2ui ? { a2ui } : {}),
    createdAt:
      typeof message.createdAt === "number" &&
      Number.isFinite(message.createdAt)
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

async function pruneLocalChatFile(path: string): Promise<void> {
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split(/\r?\n/);
    const lineCount =
      lines.length > 0 && lines[lines.length - 1] === ""
        ? lines.length - 1
        : lines.length;
    if (lineCount <= MAX_LOCAL_CHAT_MESSAGES) return;
    const kept = parseLocalChatLines(lines).slice(-MAX_LOCAL_CHAT_MESSAGES);
    const next = kept
      .map((m) =>
        JSON.stringify({
          type: "aethon_chat",
          id: m.id,
          role: m.role,
          ...(m.text ? { text: m.text } : {}),
          ...(m.thinking ? { thinking: m.thinking } : {}),
          ...(m.attachments && m.attachments.length > 0
            ? { attachments: m.attachments }
            : {}),
          ...(m.a2ui ? { a2ui: m.a2ui } : {}),
          ...(typeof m.createdAt === "number"
            ? { createdAt: m.createdAt }
            : {}),
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
