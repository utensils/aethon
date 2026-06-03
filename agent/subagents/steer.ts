/**
 * Explicit `@name` subagent invocation.
 *
 * When a user opens a chat message with `@<name>`, that's an explicit request
 * to delegate to the named subagent. Detection lives here (shared by the chat
 * handler) and the one-shot system steer that nudges the model to call the
 * `task` tool lives here too (consumed by the `before_agent_start` hook). Kept
 * separate from the parser so it has no IO and is trivially unit-tested.
 */

/** A leading `@name` mention. Case-insensitive on input; the captured name is
 *  lower-cased by the caller to match the canonical registry key. */
const MENTION_RE = /^@([A-Za-z0-9][A-Za-z0-9_-]{0,63})\b/;

/**
 * Detect a leading `@name` mention in a chat message. Returns the lowercased
 * name (caller checks it against the registry) or null when absent.
 */
export function detectSubagentMention(content: string): string | null {
  const match = MENTION_RE.exec(content.trimStart());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Build the per-turn system steer appended when the user explicitly invoked a
 * subagent. A same-turn system instruction is far more reliable than relying on
 * the model to notice the `@name` convention, while keeping the user's message
 * intact in the transcript.
 */
export function buildExplicitSubagentSteer(name: string): string {
  return (
    `The user explicitly invoked the "${name}" subagent. Delegate this request ` +
    `to it by calling the \`task\` tool with subagent_type="${name}" and a ` +
    `complete, self-contained prompt. Do not perform the task yourself.`
  );
}
