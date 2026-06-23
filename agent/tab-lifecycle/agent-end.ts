import {
  extractAgentEndError,
  formatAgentErrorMessage,
  isContextLengthExceededError,
  isRetryableAgentEndError,
  isUsageLimitError,
} from "../agent-errors";
import { tryAutoSwitchOnUsageLimit } from "../auth-profiles";
import { resetContextOverflowRecovery } from "../context-overflow-recovery";
import { logger } from "../logger";
import type { AethonAgentState, TabRecord } from "../state";
import { scheduleAethonRetry } from "./retry";
import { startContextOverflowRecovery } from "./context-recovery";
import { synthesizeCancelledSubagentToolResults } from "./tools";
import {
  compactCompletedTurnThenFinalize,
  finalizeCompletedTurn,
  finalizeFailedTurn,
  shouldCompactCompletedTurn,
  type LastAssistantMessage,
} from "./turn-finalization";
import type { TabLifecycleDeps } from "./utils";
import { modelKey } from "./utils";

const turnLog = logger.scope("turn");

export function handleAgentEnd(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  event: { type: string } & Record<string, unknown>,
): void {
  const messages = (event as { messages?: unknown[] }).messages;
  const failedMessage = extractAgentEndError(messages);
  const retrying =
    (rec.session as { isRetrying?: boolean } | undefined)?.isRetrying === true;
  const retryableFailure =
    failedMessage !== undefined && isRetryableAgentEndError(failedMessage);
  const keepTurnOpenForRetry =
    retryableFailure &&
    (retrying || scheduleAethonRetry(state, deps, rec, tabId));
  // Codex can surface context-window overflow as a raw JSON payload after
  // agent_end. Keep the turn open while pi (or Aethon as fallback)
  // compacts and resumes instead of rendering that payload as terminal.
  const contextLengthFailure =
    failedMessage !== undefined &&
    !keepTurnOpenForRetry &&
    isContextLengthExceededError(failedMessage);
  let terminalContextLengthError: string | undefined;
  const keepTurnOpenForContextRecovery =
    contextLengthFailure && rec.contextOverflowRecoveryAttempted !== true;
  if (contextLengthFailure && keepTurnOpenForContextRecovery) {
    startContextOverflowRecovery(state, deps, rec, tabId, failedMessage);
  } else if (contextLengthFailure) {
    terminalContextLengthError =
      "Context window is still too large after compacting. Try reducing context or switching to a larger-context model.";
  }
  // A usage-limit hit triggers an async account hop. Keep the turn open
  // until that decision resolves — finalizing now would clear `waiting`
  // and could drain queued messages onto the rate-limited account before
  // the resumed turn starts.
  const usageLimitFailure =
    failedMessage !== undefined &&
    !keepTurnOpenForRetry &&
    !keepTurnOpenForContextRecovery &&
    isUsageLimitError(failedMessage);
  const keepTurnOpenForAutoSwitch = usageLimitFailure;
  if (usageLimitFailure) {
    const clean = formatAgentErrorMessage(failedMessage);
    void tryAutoSwitchOnUsageLimit(state, deps, tabId)
      .then((switched) => {
        if (switched) return; // the resumed turn owns finalization
        deps.send({ type: "error", tabId, message: clean });
        finalizeFailedTurn(state, deps, tabId, failedMessage);
      })
      .catch(() => {
        // Auto-switch setup threw (e.g. session recreate failed). The
        // turn was held open, so finalize it now or the tab stays busy.
        deps.send({ type: "error", tabId, message: clean });
        finalizeFailedTurn(state, deps, tabId, failedMessage);
      });
  } else if (terminalContextLengthError) {
    deps.send({
      type: "error",
      tabId,
      message: terminalContextLengthError,
    });
  } else if (
    failedMessage &&
    !keepTurnOpenForRetry &&
    !keepTurnOpenForContextRecovery
  ) {
    deps.send({
      type: "error",
      tabId,
      message: formatAgentErrorMessage(failedMessage),
    });
  } else if (!failedMessage) {
    // Clean turn — reset recovery loop guards so future turns can switch
    // accounts or compact again.
    rec.autoSwitchTried = undefined;
    resetContextOverflowRecovery(rec);
  }
  const startMs = state.turnStartTimes.get(tabId);
  state.turnStartTimes.delete(tabId);
  const durationMs = startMs !== undefined ? Date.now() - startMs : -1;
  const modelStr = rec.session.model ? modelKey(rec.session.model) : "unknown";
  const lastAssistant = [...((messages ?? []) as LastAssistantMessage[])]
    .reverse()
    .find((m) => m?.role === "assistant");
  const reason = lastAssistant?.stopReason ?? "unknown";
  const log = `end model=${modelStr} tabId=${tabId} durationMs=${durationMs} stopReason=${reason}`;
  if (reason === "error") {
    turnLog.warn(log);
  } else {
    turnLog.info(log);
  }
  synthesizeCancelledSubagentToolResults(state, rec, tabId);
  for (const [toolCallId, cached] of rec.toolArgsCache) {
    if (cached.endedAt !== undefined) rec.toolArgsCache.delete(toolCallId);
  }
  if (
    !keepTurnOpenForRetry &&
    !keepTurnOpenForAutoSwitch &&
    !keepTurnOpenForContextRecovery
  ) {
    if (!failedMessage && shouldCompactCompletedTurn(state, tabId, rec)) {
      compactCompletedTurnThenFinalize(
        state,
        deps,
        rec,
        tabId,
        lastAssistant,
      );
      return;
    }
    finalizeCompletedTurn(state, deps, rec, tabId, lastAssistant, failedMessage);
  }
}
