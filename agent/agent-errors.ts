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

export function isRetryableAgentEndError(message: string): boolean {
  return RETRYABLE_AGENT_ERROR_RE.test(message);
}
