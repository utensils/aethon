import {
  clearLiveContextUsageEstimate,
  contextUsageSnapshot,
  emitContextUsage,
} from "../context-usage";
import { resetContextOverflowRecovery } from "../context-overflow-recovery";
import type { AethonAgentState, TabRecord } from "../state";
import { cancelAethonRetry } from "./retry";
import {
  emitFinalAssistantContent,
  rollResponseMessage,
} from "./response-stream";
import { synthesizeCancelledSubagentToolResults } from "./tools";
import type { TabLifecycleDeps } from "./utils";

interface CompactSession {
  compact?: (customInstructions?: string) => Promise<unknown>;
}

export type LastAssistantMessage =
  | {
      role?: string;
      stopReason?: string;
      content?: unknown;
      id?: unknown;
      messageId?: unknown;
    }
  | undefined;

export function shouldCompactCompletedTurn(
  state: AethonAgentState,
  tabId: string,
  rec: TabRecord,
): boolean {
  const snapshot = contextUsageSnapshot(state, tabId, rec);
  if (!snapshot?.autoCompactEnabled) return false;
  if (rec.contextUsageTransientTokens === undefined) return false;
  if (rec.contextUsageTransientTokens <= 0) return false;
  if (typeof (rec.session as CompactSession).compact !== "function") {
    return false;
  }
  return snapshot.estimatedTokensUntilCompact === 0;
}

export function compactCompletedTurnThenFinalize(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  lastAssistant: LastAssistantMessage,
): void {
  rec.promptInFlight = true;
  rec.agentEndFired = false;
  state.currentAgentTabId = tabId;
  deps.send({
    type: "notice",
    tabId,
    busy: true,
    message: "Context threshold reached; compacting before the next turn...",
  });
  const session = rec.session as CompactSession;
  void session
    .compact?.()
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.send({
        type: "error",
        tabId,
        message: `auto-compaction failed: ${message}`,
      });
    })
    .finally(() => {
      finalizeCompletedTurn(state, deps, rec, tabId, lastAssistant);
    });
}

export function finalizeCompletedTurn(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  lastAssistant: LastAssistantMessage,
  failedMessage?: string,
): void {
  cancelAethonRetry(rec);
  if (failedMessage) resetContextOverflowRecovery(rec);
  rec.agentEndFired = true;
  rec.promptInFlight = false;
  if (state.currentAgentTabId === tabId) {
    state.currentAgentTabId = undefined;
  }
  emitFinalAssistantContent(state, deps, rec, tabId, lastAssistant);
  rollResponseMessage(rec);
  clearLiveContextUsageEstimate(rec);
  emitContextUsage(state, deps, tabId, rec);
  // Back-fill pi entry ids onto the just-streamed messages so the rollback /
  // fork affordances work without a reload.
  emitEntryIds(deps, rec, tabId);
  deps.send({ type: "response_end", tabId });
  emitScheduledRunComplete(deps, rec, tabId, !failedMessage, failedMessage);
}

/**
 * Finalize a turn that ended in failure — used by async recovery paths when
 * the turn was held open during a retry/account-hop/compaction decision.
 * Operates on the tab's current record (auto-switch may replace it) and is
 * idempotent.
 */
export function finalizeFailedTurn(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  tabId: string,
  failedMessage: string | undefined,
): void {
  const rec = state.tabs.get(tabId);
  if (!rec || rec.agentEndFired) return;
  cancelAethonRetry(rec);
  resetContextOverflowRecovery(rec);
  synthesizeCancelledSubagentToolResults(state, rec, tabId);
  rec.agentEndFired = true;
  rec.promptInFlight = false;
  if (state.currentAgentTabId === tabId) {
    state.currentAgentTabId = undefined;
  }
  rollResponseMessage(rec);
  deps.send({ type: "response_end", tabId });
  emitScheduledRunComplete(deps, rec, tabId, false, failedMessage);
}

export function emitScheduledRunComplete(
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  success: boolean,
  error?: string,
): void {
  const scheduled = rec.scheduledRun;
  if (!scheduled) return;
  deps.send({
    type: "scheduled_task_run_complete",
    tabId,
    taskId: scheduled.taskId,
    runId: scheduled.runId,
    success,
    ...(error ? { error } : {}),
    ...(scheduled.completeRequested ? { completeTask: true } : {}),
  });
  rec.scheduledRun = undefined;
}

/** Emit the current branch's user/assistant message entry ids, in order, so
 *  the frontend can back-fill `entryId` onto its live transcript and offer
 *  rollback / fork before a reload. Best-effort: branching is the user's escape
 *  hatch, never a turn-critical path, so any failure is swallowed. */
function emitEntryIds(
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
): void {
  let branch: ReadonlyArray<unknown>;
  try {
    branch = rec.session.sessionManager.getBranch();
  } catch {
    return;
  }
  const entries: { entryId: string; role: "user" | "agent" }[] = [];
  for (const raw of branch) {
    const entry = raw as {
      type?: string;
      id?: unknown;
      message?: { role?: unknown };
    };
    if (entry.type !== "message" || typeof entry.id !== "string") continue;
    const role = entry.message?.role;
    if (role === "user") entries.push({ entryId: entry.id, role: "user" });
    else if (role === "assistant") {
      entries.push({ entryId: entry.id, role: "agent" });
    }
  }
  if (entries.length > 0) {
    deps.send({ type: "entry_ids", tabId, entries });
  }
}
