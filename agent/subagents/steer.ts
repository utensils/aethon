/**
 * Explicit `@name` subagent invocation.
 *
 * When a user opens a chat message with `@<name>`, that's an explicit request
 * to delegate to the named subagent. Detection lives here (shared by the chat
 * handler) and the one-shot system steer that nudges the model to call the
 * `task` tool lives here too (consumed by the `before_agent_start` hook). Kept
 * separate from the parser so it has no IO and is trivially unit-tested.
 */

export type ExplicitSubagentSurface = "inline" | "background";

/** A leading `@name` mention. Case-insensitive on input; the captured name is
 *  lower-cased by the caller to match the canonical registry key. */
const MENTION_RE =
  /^@([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?=$|\s|[,;:!?)}\]]|\.(?:\s|$))/;

const BACKGROUND_RE =
  /\b(async|background|separate\s+tabs?|don'?t\s+wait|do\s+not\s+wait)\b/i;

/**
 * Detect a leading `@name` mention in a chat message. Returns the lowercased
 * name (caller checks it against the registry) or null when absent.
 */
export function detectSubagentMention(content: string): string | null {
  return detectLeadingSubagentMentions(content)[0] ?? null;
}

/** Detect one or more leading `@name` mentions. Allows natural chains like
 *  `@kimi and @glm-5-2 review`, but stops before ordinary prompt text so a
 *  single `@reviewer check this` stays a one-agent handoff. */
export function detectLeadingSubagentMentions(content: string): string[] {
  let rest = content.trimStart();
  const names: string[] = [];
  let expectMention = true;

  while (expectMention) {
    const match = MENTION_RE.exec(rest);
    if (!match) break;
    names.push(match[1].toLowerCase());
    rest = rest.slice(match[0].length).trimStart();
    if (!rest.startsWith("@")) {
      const separator = /^(?:[,;]\s*)?(?:and|&)\s+/i.exec(rest);
      if (separator) rest = rest.slice(separator[0].length).trimStart();
      else if (/^[,;]\s*@/.test(rest)) {
        rest = rest.replace(/^[,;]\s*/, "");
      } else {
        expectMention = false;
      }
    }
  }

  return names;
}

export function detectBackgroundSubagentIntent(content: string): boolean {
  return BACKGROUND_RE.test(content);
}

/**
 * Build the per-turn system steer appended when the user explicitly invoked a
 * subagent. A same-turn system instruction is far more reliable than relying on
 * the model to notice the `@name` convention, while keeping the user's message
 * intact in the transcript.
 */
export function buildExplicitSubagentSteer(
  names: string | string[],
  opts: { surface?: ExplicitSubagentSurface } = {},
): string {
  const list = Array.isArray(names) ? names : [names];
  const surface = opts.surface ?? "inline";
  if (list.length > 1) {
    const quoted = list.map((name) => `"${name}"`).join(", ");
    const background =
      surface === "background"
        ? " Launch them as non-focused background tabs."
        : "";
    return (
      `The user explicitly invoked multiple subagents: ${quoted}. Delegate ` +
      `this whole request by calling the \`task_batch\` tool with one ordered ` +
      `task per named subagent and surface="${surface}". Each task prompt must ` +
      `be complete and self-contained. Do not perform the task yourself.` +
      background
    );
  }
  const name = list[0];
  const surfaceClause =
    surface === "background" ? ' and surface="background"' : "";
  return (
    `The user explicitly invoked the "${name}" subagent. Delegate this request ` +
    `to it by calling the \`task\` tool with subagent_type="${name}"${surfaceClause} and a ` +
    `complete, self-contained prompt. Do not perform the task yourself.`
  );
}
