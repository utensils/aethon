import {
  formatAgentErrorMessage,
  isUsageLimitError,
} from "../agent-errors";
import { tryAutoSwitchOnUsageLimit } from "../auth-profiles";
import { resetContextOverflowRecovery } from "../context-overflow-recovery";
import type { AethonAgentState, TabRecord } from "../state";
import { cancelAethonRetry } from "./retry";
import { rollResponseMessage } from "./response-stream";
import {
  emitScheduledRunComplete,
  finalizeFailedTurn,
} from "./turn-finalization";
import type { TabLifecycleDeps } from "./utils";

export function handleAutoRetryStart(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  event: { type: string } & Record<string, unknown>,
): void {
  const ev = event as {
    attempt?: number;
    maxAttempts?: number;
    delayMs?: number;
    errorMessage?: string;
  };
  cancelAethonRetry(rec);
  rec.promptInFlight = true;
  rec.agentEndFired = false;
  state.currentAgentTabId = tabId;
  deps.send({
    type: "notice",
    tabId,
    busy: true,
    message: `Transient provider error; retrying ${
      ev.attempt ?? "?"
    }/${ev.maxAttempts ?? "?"} in ${Math.max(
      0,
      Math.round((ev.delayMs ?? 0) / 1000),
    )}s.`,
  });
}

export function handleAutoRetryEnd(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  event: { type: string } & Record<string, unknown>,
): void {
  const ev = event as { success?: boolean; finalError?: string };
  cancelAethonRetry(rec);
  if (!ev.success && ev.finalError) {
    const finalError = ev.finalError;
    if (isUsageLimitError(finalError)) {
      // Hop to an account with headroom and resume. Keep the turn open
      // until the decision resolves — finalizing now would clear
      // `waiting` and could drain queued messages onto the rate-limited
      // account before the resumed turn starts.
      const clean = formatAgentErrorMessage(finalError);
      void tryAutoSwitchOnUsageLimit(state, deps, tabId)
        .then((switched) => {
          if (switched) return; // the resumed turn owns finalization
          deps.send({ type: "error", tabId, message: clean });
          finalizeFailedTurn(state, deps, tabId, finalError);
        })
        .catch(() => {
          // Auto-switch setup threw; finalize so the tab doesn't hang.
          deps.send({ type: "error", tabId, message: clean });
          finalizeFailedTurn(state, deps, tabId, finalError);
        });
      return;
    }
    // Transient failures keep the "auto-retry exhausted:" prefix so the
    // user knows we already retried.
    deps.send({
      type: "error",
      tabId,
      message: `auto-retry exhausted: ${finalError}`,
    });
    resetContextOverflowRecovery(rec);
    rec.agentEndFired = true;
    rec.promptInFlight = false;
    if (state.currentAgentTabId === tabId) {
      state.currentAgentTabId = undefined;
    }
    rollResponseMessage(rec);
    deps.send({ type: "response_end", tabId });
    emitScheduledRunComplete(deps, rec, tabId, false, ev.finalError);
  }
}
