import { isRetryableAgentEndError } from "../agent-errors";

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
