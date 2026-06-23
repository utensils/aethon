/*
 * Per-tab pi session event dispatcher. The dispatcher intentionally stays
 * small and delegates domain work to focused modules so the lifecycle module
 * can still pass one subscriber callback while each event family remains
 * testable in isolation.
 *
 * Load-bearing contracts upheld by the delegated handlers:
 *  - `tool_execution_end` with a known `toolCallId` updates the same
 *    `uiId` (no duplicate cards) — the cached `uiId` from
 *    `tool_execution_start` is reused on end.
 *  - `agent_start` after a previous `agent_end` while `queuedCount > 0`
 *    re-marks `promptInFlight` so a follow-up chat / set_model on this
 *    tab queues correctly instead of being treated as a fresh idle prompt.
 *  - `agent_end` always emits `response_end` so the frontend can release
 *    the turn UI, even on error, except for deliberate held-open recovery
 *    paths that later finalize or resume.
 *  - Streaming assistant text/thinking ids are synthetic per assistant
 *    segment and roll at tool boundaries; never key them from pi event
 *    timestamps, which can point at earlier transcript records.
 */

import { supportsCodexFastMode } from "../codex-fast-mode";
import {
  clearLiveContextUsageEstimate,
  emitContextUsage,
} from "../context-usage";
import { logger } from "../logger";
import type { AethonAgentState, TabRecord } from "../state";
import { handleAgentEnd } from "./agent-end";
import {
  compactionNotice,
  handleAgentStartContextRecovery,
  handleContextOverflowCompactionEvent,
} from "./context-recovery";
import {
  handleAutoRetryEnd,
  handleAutoRetryStart,
} from "./retry-recovery";
import {
  handleResponseMessageUpdate,
  rollResponseMessage,
} from "./response-stream";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "./tool-events";
import type { TabLifecycleDeps } from "./utils";
import { modelKey } from "./utils";

const turnLog = logger.scope("turn");

/** Per-tab pi session event subscriber. Extracted so tests can drive it
 *  directly with synthetic event payloads. */
export function handleSessionEvent(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  // Pi's event union is large and changes between versions; widen here so
  // the dispatch stays tight in the bridge without coupling to its
  // exhaustive shape.
  event: { type: string } & Record<string, unknown>,
): void {
  const compacting = compactionNotice(event);
  if (compacting) {
    if (!compacting.busy) {
      clearLiveContextUsageEstimate(rec);
    }
    deps.send({
      type: "notice",
      tabId,
      ...(compacting.busy ? { busy: true } : {}),
      message: compacting.message,
    });
    emitContextUsage(state, deps, tabId, rec, {
      compacting: compacting.busy === true,
    });
  }
  handleContextOverflowCompactionEvent(state, deps, rec, tabId, event);

  switch (event.type) {
    case "agent_start": {
      handleAgentStart(state, deps, rec, tabId);
      break;
    }
    case "thinking_level_changed": {
      deps.send({
        type: "thinking_level_changed",
        tabId,
        model: rec.session.model ? modelKey(rec.session.model) : "",
        thinkingLevel: rec.session.thinkingLevel,
        thinkingLevels: rec.session.getAvailableThinkingLevels(),
        codexFastMode: state.codexFastMode,
        codexFastModeSupported: supportsCodexFastMode(rec.session.model),
      });
      break;
    }
    case "message_update": {
      handleResponseMessageUpdate(state, deps, rec, tabId, event);
      break;
    }
    case "tool_execution_start": {
      handleToolExecutionStart(state, deps, rec, tabId, event);
      break;
    }
    case "tool_execution_update": {
      handleToolExecutionUpdate(state, deps, rec, tabId, event);
      break;
    }
    case "tool_execution_end": {
      handleToolExecutionEnd(state, deps, rec, tabId, event);
      break;
    }
    case "agent_end": {
      handleAgentEnd(state, deps, rec, tabId, event);
      break;
    }
    case "auto_retry_start": {
      handleAutoRetryStart(state, deps, rec, tabId, event);
      break;
    }
    case "auto_retry_end": {
      handleAutoRetryEnd(state, deps, rec, tabId, event);
      break;
    }
  }
}

function handleAgentStart(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
): void {
  handleAgentStartContextRecovery(rec);
  rollResponseMessage(rec);
  clearLiveContextUsageEstimate(rec);
  state.currentAgentTabId = tabId;
  state.turnStartTimes.set(tabId, Date.now());
  emitContextUsage(state, deps, tabId, rec);
  const model = rec.session.model ? modelKey(rec.session.model) : "unknown";
  turnLog.info(`start model=${model} tabId=${tabId}`);
  if (rec.queuedCount > 0) {
    rec.queuedCount -= 1;
    // The previous agent_end cleared promptInFlight, but pi has already
    // started the queue-drained turn — re-mark in-flight so a follow-up chat /
    // set_model on this tab queues correctly instead of being treated as a
    // fresh idle prompt.
    rec.promptInFlight = true;
    rec.agentEndFired = false;
    deps.send({
      type: "prompt_started",
      tabId,
      source: "queue",
      queued: rec.queuedCount,
    });
  }
}
