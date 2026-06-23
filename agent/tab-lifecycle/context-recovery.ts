import { formatAgentErrorMessage } from "../agent-errors";
import {
  cancelContextOverflowRecoveryTimer,
  clearActiveContextOverflowRecovery,
} from "../context-overflow-recovery";
import type { AethonAgentState, TabRecord } from "../state";
import { cancelAethonRetry, removeTrailingFailureMessage } from "./retry";
import { finalizeFailedTurn } from "./turn-finalization";
import type { TabLifecycleDeps } from "./utils";

const CONTEXT_OVERFLOW_RECOVERY_FALLBACK_DELAY_MS = 250;

export interface CompactAndContinueSession {
  compact?: (customInstructions?: string) => Promise<unknown>;
  agent?: {
    continue?: () => Promise<void>;
  };
}

export function compactionNotice(
  event: { type: string } & Record<string, unknown>,
): { message: string; busy?: true } | undefined {
  const phase = compactionPhase(event);
  if (!phase) return undefined;
  if (phase === "start") {
    return { message: "Compacting context...", busy: true };
  }
  if (phase === "failure") {
    return { message: compactionFailureMessage(event) };
  }
  const tokens = compactionTokensBefore(event);
  const tokensBefore =
    tokens === undefined
      ? ""
      : ` · ${tokens.toLocaleString("en-US")} tokens summarized`;
  return { message: `Context compacted${tokensBefore}` };
}

function compactionPhase(
  event: { type: string } & Record<string, unknown>,
): "start" | "success" | "failure" | undefined {
  const type = event.type.toLowerCase();
  if (!type.includes("compact")) return undefined;
  if (type.includes("start") || type.includes("begin")) return "start";
  if (
    typeof event.errorMessage === "string" ||
    event.aborted === true ||
    type.includes("fail") ||
    type.includes("error")
  ) {
    return "failure";
  }
  if (
    type.includes("end") ||
    type.includes("finish") ||
    type.includes("complete") ||
    type.includes("success")
  ) {
    return "success";
  }
  return undefined;
}

function compactionFailureMessage(
  event: { type: string } & Record<string, unknown>,
): string {
  if (typeof event.errorMessage === "string" && event.errorMessage.length > 0) {
    return event.errorMessage;
  }
  if (event.aborted === true) {
    return "Context compaction cancelled.";
  }
  const reason =
    typeof event.error === "string"
      ? event.error
      : typeof event.message === "string"
        ? event.message
        : "unknown error";
  return `Context compaction failed: ${reason}`;
}

function compactionTokensBefore(
  event: { type: string } & Record<string, unknown>,
): number | undefined {
  if (
    typeof event.tokensBefore === "number" &&
    Number.isFinite(event.tokensBefore)
  ) {
    return event.tokensBefore;
  }
  const result = event.result as { tokensBefore?: unknown } | undefined;
  return typeof result?.tokensBefore === "number" &&
    Number.isFinite(result.tokensBefore)
    ? result.tokensBefore
    : undefined;
}

export function startContextOverflowRecovery(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  failedMessage: string,
): void {
  cancelAethonRetry(rec);
  cancelContextOverflowRecoveryTimer(rec);
  rec.contextOverflowRecoveryAttempted = true;
  rec.contextOverflowRecoveryInFlight = true;
  rec.contextOverflowRecoveryCompactionStarted = false;
  rec.contextOverflowRecoveryFallbackRunning = false;
  rec.contextOverflowRecoveryErrorMessage = failedMessage;
  rec.promptInFlight = true;
  rec.agentEndFired = false;
  state.currentAgentTabId = tabId;
  deps.send({
    type: "notice",
    tabId,
    busy: true,
    message: formatAgentErrorMessage(failedMessage),
  });
  rec.contextOverflowRecoveryTimer = setTimeout(() => {
    rec.contextOverflowRecoveryTimer = undefined;
    void runContextOverflowRecoveryFallback(state, deps, tabId, failedMessage);
  }, CONTEXT_OVERFLOW_RECOVERY_FALLBACK_DELAY_MS);
}

async function runContextOverflowRecoveryFallback(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  tabId: string,
  failedMessage: string,
): Promise<void> {
  const rec = state.tabs.get(tabId);
  if (!rec?.contextOverflowRecoveryInFlight) return;
  if (rec.contextOverflowRecoveryCompactionStarted) return;
  const session = rec.session as CompactAndContinueSession;
  const agent = session.agent;
  if (
    typeof session.compact !== "function" ||
    typeof agent?.continue !== "function"
  ) {
    deps.send({
      type: "error",
      tabId,
      message:
        "Context window exceeded, but this session cannot compact and resume automatically.",
    });
    finalizeFailedTurn(state, deps, tabId, failedMessage);
    return;
  }

  rec.contextOverflowRecoveryFallbackRunning = true;
  rec.contextOverflowRecoveryCompactionStarted = true;
  deps.send({
    type: "notice",
    tabId,
    busy: true,
    message: "Context overflow detected; compacting before resuming...",
  });
  try {
    await session.compact();
    await continueAfterContextCompaction(state, deps, tabId, failedMessage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({
      type: "error",
      tabId,
      message: `Context overflow recovery failed: ${message}`,
    });
    finalizeFailedTurn(state, deps, tabId, failedMessage);
  } finally {
    const live = state.tabs.get(tabId);
    if (live) live.contextOverflowRecoveryFallbackRunning = false;
  }
}

async function continueAfterContextCompaction(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  tabId: string,
  failedMessage: string,
): Promise<void> {
  const rec = state.tabs.get(tabId);
  if (!rec?.contextOverflowRecoveryInFlight) return;
  const session = rec.session as CompactAndContinueSession;
  const agent = session.agent;
  if (typeof agent?.continue !== "function") {
    deps.send({
      type: "error",
      tabId,
      message:
        "Context compacted, but this session cannot resume automatically.",
    });
    finalizeFailedTurn(state, deps, tabId, failedMessage);
    return;
  }
  removeTrailingFailureMessage(rec.session);
  rec.promptInFlight = true;
  rec.agentEndFired = false;
  state.currentAgentTabId = tabId;
  deps.send({
    type: "notice",
    tabId,
    busy: true,
    message: "Context compacted; resuming...",
  });
  try {
    await agent.continue();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({ type: "error", tabId, message: `resume: ${message}` });
    finalizeFailedTurn(state, deps, tabId, failedMessage);
  }
}

export function handleContextOverflowCompactionEvent(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  event: { type: string } & Record<string, unknown>,
): void {
  if (!rec.contextOverflowRecoveryInFlight) return;
  const failedMessage = rec.contextOverflowRecoveryErrorMessage;
  if (!failedMessage) return;
  const phase = compactionPhase(event);
  if (!phase) return;
  if (phase === "start") {
    cancelContextOverflowRecoveryTimer(rec);
    rec.contextOverflowRecoveryCompactionStarted = true;
    return;
  }
  cancelContextOverflowRecoveryTimer(rec);
  if (phase === "failure") {
    if (rec.contextOverflowRecoveryFallbackRunning) return;
    deps.send({
      type: "error",
      tabId,
      message:
        event.aborted === true
          ? "Context overflow recovery cancelled during compaction."
          : compactionFailureMessage(event),
    });
    finalizeFailedTurn(state, deps, tabId, failedMessage);
    return;
  }
  if (rec.contextOverflowRecoveryFallbackRunning) return;
  if (event.willRetry === true) return;
  void continueAfterContextCompaction(state, deps, tabId, failedMessage);
}

export function handleAgentStartContextRecovery(rec: TabRecord): void {
  if (rec.contextOverflowRecoveryInFlight) {
    clearActiveContextOverflowRecovery(rec);
  } else {
    rec.contextOverflowRecoveryAttempted = false;
  }
}
