/**
 * Pure helpers for the composer's `@` completion.
 *
 * The agent bridge already parses `@path` / `@"path with spaces"` tokens
 * out of the prompt and inlines the referenced files as deterministic
 * context (agent/file-references.ts). These helpers exist so the picker
 * only ever inserts text that round-trips through that parser: the same
 * `@`-boundary rule (an email's `@` never starts a reference) and the
 * same quoting/escaping rules for paths containing whitespace.
 *
 * IO-free by design — files and subagents come from the `useAtMention` hook.
 */

import { fuzzyScore } from "./palette-items";
import { activeWorkspaceCwd } from "../../utils/activeWorkspaceRoot";
import {
  isSafeSubagentName,
  parseSubagentContent,
  type SubagentFile,
  type SubagentSurface,
} from "../../subagents";

export interface AtFileMatch {
  /** Project-relative path — what gets inserted after the `@`. */
  rel: string;
  /** Absolute path on disk (kept for icon resolution / open actions). */
  path: string;
}

export interface AtSubagentMatch {
  kind: "agent";
  name: string;
  description: string;
  model?: string;
  surface: SubagentSurface;
}

export interface AtFileSuggestion extends AtFileMatch {
  kind: "file";
}

export type AtMentionMatch = AtSubagentMatch | AtFileSuggestion;

export interface AtToken {
  /** Text between the `@` and the cursor, leading quote stripped. */
  query: string;
  /** Index of the `@` in the draft. */
  start: number;
  /** End of the token — first whitespace at/after the cursor, or EOL. */
  end: number;
}

export interface AtMention extends AtToken {
  matches: AtMentionMatch[];
}

/** Upper bound on rendered suggestions; matches quick-open's feel. */
export const AT_MATCH_LIMIT = 12;

const AGENT_QUERY_RE = /^[A-Za-z0-9_-]*$/;

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
 * Merge raw subagent files into effective suggestions. User scope loads first,
 * project scope second, so project definitions override by name exactly like
 * the bridge loader.
 */
export function subagentSuggestionsFromFiles(
  files: SubagentFile[],
): AtSubagentMatch[] {
  const merged = new Map<string, AtSubagentMatch>();
  for (const file of files) {
    const name = file.name.trim().toLowerCase();
    if (!isSafeSubagentName(name)) continue;
    const parsed = parseSubagentContent(file.content);
    if (!parsed.fields) continue;
    merged.set(name, {
      kind: "agent",
      name,
      description: parsed.fields.description,
      model: parsed.fields.model,
      surface: parsed.fields.surface,
    });
  }
  return [...merged.values()].sort((a, b) =>
    a.name === b.name ? 0 : a.name < b.name ? -1 : 1,
  );
}

export function isLeadingAtToken(value: string, token: AtToken): boolean {
  const firstNonSpace = value.search(/\S/);
  return firstNonSpace >= 0 && token.start === firstNonSpace;
}

/**
 * Whether to offer subagent suggestions for this `@token`. Agents surface when
 * the `@` is the leading token (the delegation prefix) OR the user has typed a
 * name fragment — so `when done have @glm` mid-message still completes to an
 * agent, while a bare mid-message `@` (empty query) stays focused on file
 * references. `matchAtSubagents` self-filters non-agent-shaped queries, so a
 * path-like token like `@src/foo` never surfaces an agent even when offered.
 */
export function shouldOfferAgents(value: string, token: AtToken): boolean {
  return isLeadingAtToken(value, token) || token.query.length > 0;
}

export function matchAtSubagents(
  query: string,
  subagents: AtSubagentMatch[],
  limit: number = AT_MATCH_LIMIT,
): AtSubagentMatch[] {
  if (!AGENT_QUERY_RE.test(query)) return [];
  if (!query) return subagents.slice(0, limit);
  const normalized = query.toLowerCase();
  const scored: { agent: AtSubagentMatch; score: number }[] = [];
  for (const agent of subagents) {
    const score = Math.max(
      fuzzyScore(normalized, agent.name) * 1.2,
      fuzzyScore(normalized, agent.description),
    );
    if (score <= 0) continue;
    scored.push({ agent, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.agent.name.length - b.agent.name.length ||
      (a.agent.name < b.agent.name ? -1 : 1),
  );
  return scored.slice(0, limit).map((s) => s.agent);
}

export function matchAtMentions({
  query,
  files,
  subagents,
  includeAgents,
  limit = AT_MATCH_LIMIT,
}: {
  query: string;
  files: AtFileMatch[];
  subagents: AtSubagentMatch[];
  includeAgents: boolean;
  limit?: number;
}): AtMentionMatch[] {
  const agentMatches = includeAgents
    ? matchAtSubagents(query, subagents, limit)
    : [];
  const remaining = Math.max(0, limit - agentMatches.length);
  const fileMatches = matchAtFiles(query, files, remaining).map(
    (file): AtFileSuggestion => ({ kind: "file", ...file }),
  );
  return [...agentMatches, ...fileMatches];
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

export function formatAtMentionInsertion(match: AtMentionMatch): string {
  return match.kind === "agent"
    ? `@${match.name} `
    : formatAtInsertion(match.rel);
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
