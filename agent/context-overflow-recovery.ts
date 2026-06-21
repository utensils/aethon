import type { TabRecord } from "./state";

export function cancelContextOverflowRecoveryTimer(rec: TabRecord): void {
  if (rec.contextOverflowRecoveryTimer) {
    clearTimeout(rec.contextOverflowRecoveryTimer);
    rec.contextOverflowRecoveryTimer = undefined;
  }
}

export function resetContextOverflowRecovery(rec: TabRecord): void {
  cancelContextOverflowRecoveryTimer(rec);
  rec.contextOverflowRecoveryAttempted = false;
  rec.contextOverflowRecoveryInFlight = false;
  rec.contextOverflowRecoveryCompactionStarted = false;
  rec.contextOverflowRecoveryFallbackRunning = false;
  rec.contextOverflowRecoveryErrorMessage = undefined;
}

export function clearActiveContextOverflowRecovery(rec: TabRecord): void {
  cancelContextOverflowRecoveryTimer(rec);
  rec.contextOverflowRecoveryInFlight = false;
  rec.contextOverflowRecoveryCompactionStarted = false;
  rec.contextOverflowRecoveryFallbackRunning = false;
  rec.contextOverflowRecoveryErrorMessage = undefined;
}
