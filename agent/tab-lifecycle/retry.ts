import { isRetryableAgentEndError } from "../agent-errors";
import type { AethonAgentState, TabRecord } from "../state";
import type { TabLifecycleDeps } from "./utils";

interface RetryClassifierSession {
  _isRetryableError?: (message: {
    stopReason?: string;
    errorMessage?: string;
  }) => boolean;
}

export function installAethonRetryClassifier(session: unknown): void {
  const target = session as RetryClassifierSession;
  if (typeof target._isRetryableError !== "function") return;

  const upstream = target._isRetryableError.bind(session);
  target._isRetryableError = (message) =>
    upstream(message) ||
    (message.stopReason === "error" &&
      typeof message.errorMessage === "string" &&
      isRetryableAgentEndError(message.errorMessage));
}

interface RetrySettings {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
}

interface AethonRetrySession {
  agent?: {
    state?: { messages?: unknown[] };
    continue?: () => Promise<void>;
  };
  settingsManager?: { getRetrySettings?: () => RetrySettings };
}

const DEFAULT_RETRY_SETTINGS = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000,
};

function retrySettings(session: unknown): Required<RetrySettings> {
  const raw = (
    session as AethonRetrySession
  ).settingsManager?.getRetrySettings?.();
  return {
    enabled: raw?.enabled ?? DEFAULT_RETRY_SETTINGS.enabled,
    maxRetries: raw?.maxRetries ?? DEFAULT_RETRY_SETTINGS.maxRetries,
    baseDelayMs: raw?.baseDelayMs ?? DEFAULT_RETRY_SETTINGS.baseDelayMs,
  };
}

export function removeTrailingFailureMessage(session: unknown): void {
  const agent = (session as AethonRetrySession).agent;
  const messages = agent?.state?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  const last = messages[messages.length - 1] as
    | { role?: unknown; stopReason?: unknown }
    | undefined;
  if (last?.role === "assistant" && last.stopReason === "error") {
    agent.state.messages = messages.slice(0, -1);
  }
}

export function cancelAethonRetry(rec: TabRecord): void {
  if (rec.aethonRetryTimer) {
    clearTimeout(rec.aethonRetryTimer);
    rec.aethonRetryTimer = undefined;
  }
  rec.aethonRetryInFlight = false;
  rec.aethonRetryAttempt = 0;
}

export function scheduleAethonRetry(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
): boolean {
  const settings = retrySettings(rec.session);
  const agent = (rec.session as AethonRetrySession).agent;
  const continueAgent = agent?.continue;
  if (!settings.enabled || typeof continueAgent !== "function") {
    cancelAethonRetry(rec);
    return false;
  }

  const attempt = (rec.aethonRetryAttempt ?? 0) + 1;
  if (attempt > settings.maxRetries) {
    cancelAethonRetry(rec);
    return false;
  }

  rec.aethonRetryAttempt = attempt;
  rec.aethonRetryInFlight = true;
  rec.promptInFlight = true;
  rec.agentEndFired = false;
  state.currentAgentTabId = tabId;
  removeTrailingFailureMessage(rec.session);

  const delayMs = settings.baseDelayMs * 2 ** (attempt - 1);
  deps.send({
    type: "notice",
    tabId,
    busy: true,
    message: `Transient provider error; retrying ${attempt}/${settings.maxRetries} in ${Math.max(
      0,
      Math.round(delayMs / 1000),
    )}s.`,
  });

  if (rec.aethonRetryTimer) clearTimeout(rec.aethonRetryTimer);
  rec.aethonRetryTimer = setTimeout(() => {
    rec.aethonRetryTimer = undefined;
    continueAgent().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      cancelAethonRetry(rec);
      rec.promptInFlight = false;
      rec.agentEndFired = true;
      if (state.currentAgentTabId === tabId) {
        state.currentAgentTabId = undefined;
      }
      deps.send({ type: "error", tabId, message: `retry: ${message}` });
      deps.send({ type: "response_end", tabId });
    });
  }, delayMs);

  return true;
}
