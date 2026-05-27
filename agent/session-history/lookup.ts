/**
 * Project-safety bridge: pick the right pi session file for a given
 * cwd. The shared `default` tab dir collects sessions from every
 * project the user worked in; `findSessionFileMatchingCwd` is what
 * keeps `ensureTab` from leaking one project's chat into another on
 * cold start. Do not refactor this into the generic parse / metadata
 * paths — the cwd-scoped early-exit on header-only reads is the
 * efficiency hook we rely on.
 */

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_CHAT_FILE, type LatestSessionLog } from "./shared";

/** Bytes to read from the head of each session file when we only need
 *  the first line. Session headers are tiny JSON objects (`type`,
 *  `cwd`, occasionally one or two more fields); 8 KB leaves room for
 *  Linux's 4 KB PATH_MAX plus any future header fields. */
const HEADER_PREFIX_BYTES = 8 * 1024;

async function readSessionHeaderCwd(path: string): Promise<string | undefined> {
  // The session header (`{type:"session", cwd: "..."}`) is always the
  // first line of the .jsonl. Read a small prefix only — full-file
  // reads add up when this is called for every file in a session dir.
  let raw: string;
  try {
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(HEADER_PREFIX_BYTES);
      const { bytesRead } = await handle.read(
        buf,
        0,
        HEADER_PREFIX_BYTES,
        0,
      );
      raw = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  const newline = raw.indexOf("\n");
  // If the first line is longer than `HEADER_PREFIX_BYTES` (vanishingly
  // unlikely for a real session header), treat the file as malformed and
  // skip it — a false negative here means the caller falls back to
  // mtime-ordered selection, which is the safe outcome.
  if (newline === -1) return undefined;
  const firstLine = raw.slice(0, newline).trim();
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
