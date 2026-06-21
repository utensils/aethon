import type { TabRecord } from "./state";

export function isUnderlyingSessionBusy(tab: TabRecord): boolean {
  const sessionFlags = tab.session as {
    isStreaming?: unknown;
    isRetrying?: unknown;
  };
  return (
    tab.aethonRetryInFlight === true ||
    tab.contextOverflowRecoveryInFlight === true ||
    sessionFlags.isStreaming === true ||
    sessionFlags.isRetrying === true
  );
}
