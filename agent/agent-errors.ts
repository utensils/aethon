/**
 * Helpers for surfacing pi-coding-agent run failures to the bridge channel.
 *
 * Pi catches API errors (auth, credit balance, network, schema) inside its
 * agent loop and reports them by pushing a synthetic assistant message with
 * `stopReason: "error"` + `errorMessage` onto the session, then emitting a
 * normal `agent_end` event. The prompt promise resolves successfully — there
 * is no exception to catch — so the bridge has to read the failure off the
 * agent_end payload itself. Aborts (`stopReason: "aborted"`) come through
 * the same channel but are deliberate user actions, not errors.
 */
export interface AgentEndMessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

export function extractAgentEndError(
  messages: readonly AgentEndMessageLike[] | undefined,
): string | undefined {
  if (!messages) return undefined;
  for (const m of messages) {
    if (
      m?.role === "assistant" &&
      m.stopReason === "error" &&
      typeof m.errorMessage === "string" &&
      m.errorMessage.length > 0
    ) {
      return m.errorMessage;
    }
  }
  return undefined;
}

const RETRYABLE_AGENT_ERROR_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|connection.?ended|websocket.?closed|1006|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/**
 * A hit on the account's usage quota (Codex `usage_limit_reached`). This is
 * NOT retryable — retrying just burns attempts against a quota that won't
 * replenish until its reset window. Detected so we can both skip the retry
 * loop and surface a clean, actionable message instead of the raw 429 JSON.
 */
export function isUsageLimitError(message: string): boolean {
  return /usage_limit_reached|usage limit has been reached/i.test(message);
}

export function isContextLengthExceededError(message: string): boolean {
  if (isUsageLimitError(message)) return false;
  return /context[_ ]length[_ ]exceeded|exceeds the context window|context window[^.]*exceeded/i.test(
    message,
  );
}

export function isRetryableAgentEndError(message: string): boolean {
  // Usage-limit 429s carry "429" so they'd otherwise look retryable; bail
  // first so we don't waste the retry budget on an unrecoverable quota hit.
  if (isUsageLimitError(message)) return false;
  return RETRYABLE_AGENT_ERROR_RE.test(message);
}

/**
 * Turn a raw agent error string into a clean, user-facing message. Today
 * this special-cases Codex usage-limit 429s and context-window overflow
 * failures whose raw provider payloads are otherwise noisy and hard to act on.
 * Everything else passes through unchanged.
 *
 * Reusable: any surface that renders an agent error can call this.
 */
export function formatAgentErrorMessage(raw: string): string {
  if (isContextLengthExceededError(raw)) {
    return "Context window exceeded. Compacting context and resuming automatically.";
  }
  if (!isUsageLimitError(raw)) return raw;
  const resetsInSeconds = readNumericField(raw, "resets_in_seconds");
  const planType = readStringField(raw, "plan_type");
  const planLabel = planType ? ` (${planType})` : "";
  const when =
    resetsInSeconds !== undefined
      ? ` Resets in ${formatDuration(resetsInSeconds)}.`
      : "";
  return `Usage limit reached for this account${planLabel}.${when} Switch to another account (Cmd+Shift+A) to keep working.`;
}

function readNumericField(raw: string, key: string): number | undefined {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
  return match ? Number(match[1]) : undefined;
}

function readStringField(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return match ? match[1] : undefined;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
