/**
 * Pure helpers for the composer's `@file` completion.
 *
 * The agent bridge already parses `@path` / `@"path with spaces"` tokens
 * out of the prompt and inlines the referenced files as deterministic
 * context (agent/file-references.ts). These helpers exist so the picker
 * only ever inserts text that round-trips through that parser: the same
 * `@`-boundary rule (an email's `@` never starts a reference) and the
 * same quoting/escaping rules for paths containing whitespace.
 *
 * IO-free by design — the file list comes from the `useAtMention` hook.
 */

import { fuzzyScore } from "./palette-items";
import { activeWorkspaceCwd } from "../../utils/activeWorkspaceRoot";

export interface AtFileMatch {
  /** Project-relative path — what gets inserted after the `@`. */
  rel: string;
  /** Absolute path on disk (kept for icon resolution / open actions). */
  path: string;
}

export interface AtToken {
  /** Text between the `@` and the cursor, leading quote stripped. */
  query: string;
  /** Index of the `@` in the draft. */
  start: number;
  /** End of the token — first whitespace at/after the cursor, or EOL. */
  end: number;
}

export interface AtMention extends AtToken {
  matches: AtFileMatch[];
}

/** Upper bound on rendered suggestions; matches quick-open's feel. */
export const AT_MATCH_LIMIT = 12;

/**
 * Find the `@token` the cursor is inside, if any. Mirrors the agent
 * parser's boundary rule: the `@` must sit at the start of the draft or
 * after whitespace / an opening bracket / a quote, so `me@example.com`
 * never opens the picker. The token may not contain whitespace — typing
 * a space closes the picker (paths with spaces are still completable by
 * fuzzy-matching the typed part, and insertion quotes them).
 */
export function findActiveAtToken(
  value: string,
  cursor: number,
): AtToken | null {
  if (cursor < 1 || cursor > value.length) return null;
  let at = -1;
  for (let i = cursor - 1; i >= 0; i -= 1) {
    const ch = value[i];
    if (/\s/.test(ch)) return null;
    if (ch === "@") {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const prev = at > 0 ? value[at - 1] : undefined;
  const boundary =
    prev === undefined || /\s/.test(prev) || "([{<'\"`".includes(prev);
  if (!boundary) return null;
  let query = value.slice(at + 1, cursor);
  // A quote right after the `@` is the user hand-typing the quoted form;
  // strip it so matching still works against bare relative paths.
  if (query.startsWith('"') || query.startsWith("'")) query = query.slice(1);
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end])) end += 1;
  return { query, start: at, end };
}

/**
 * Rank project files against the typed query. Scores both the full
 * relative path and the basename (slightly boosted) so `app` surfaces
 * `src/App.tsx` ahead of paths that merely contain the letters. Empty
 * query shows the walk's stable ordering — same as opening Cmd+P.
 */
export function matchAtFiles(
  query: string,
  files: AtFileMatch[],
  limit: number = AT_MATCH_LIMIT,
): AtFileMatch[] {
  if (!query) return files.slice(0, limit);
  const scored: { file: AtFileMatch; score: number }[] = [];
  for (const file of files) {
    const base = file.rel.slice(file.rel.lastIndexOf("/") + 1);
    const score = Math.max(
      fuzzyScore(query, file.rel),
      fuzzyScore(query, base) * 1.1,
    );
    if (score <= 0) continue;
    scored.push({ file, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.file.rel.length - b.file.rel.length ||
      (a.file.rel < b.file.rel ? -1 : 1),
  );
  return scored.slice(0, limit).map((s) => s.file);
}

/**
 * Format the text that replaces the `@token`. Plain paths insert as
 * `@rel `; anything the agent's unquoted reader would mis-tokenize
 * (whitespace, quotes, backslashes) gets the quoted form with the same
 * escapes `readQuoted` in agent/file-references.ts understands. The
 * trailing space ends the token so the picker closes after insertion.
 */
export function formatAtInsertion(rel: string): string {
  if (!/[\s"'\\]/.test(rel)) return `@${rel} `;
  const escaped = rel.replace(/[\\"]/g, (ch) => `\\${ch}`);
  return `@"${escaped}" `;
}

/**
 * Root the completion list should come from. The agent resolves `@refs`
 * against the tab's recorded cwd first (agent/chat.ts), then the active
 * project — mirror that precedence so suggestions match what will
 * actually resolve.
 */
export function atMentionRoot(state: Record<string, unknown>): string | null {
  const tabs =
    (state.tabs as Array<{ id: string; cwd?: string }> | undefined) ?? [];
  const activeTabId =
    typeof state.activeTabId === "string" ? state.activeTabId : undefined;
  const activeTab = activeTabId
    ? tabs.find((t) => t.id === activeTabId)
    : undefined;
  if (activeTab?.cwd) return activeTab.cwd;
  return activeWorkspaceCwd(state);
}
