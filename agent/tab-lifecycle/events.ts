/**
 * Per-tab pi session event dispatcher. The big switch is here so the
 * lifecycle module can import it as a single reference and pass it as
 * the subscriber callback. Closes over the TabRecord (passed in by the
 * caller) so per-turn counters and the tool-args cache stay tab-local.
 *
 * Load-bearing contracts upheld here:
 *  - `tool_execution_end` with a known `toolCallId` updates the same
 *    `uiId` (no duplicate cards) — the cached `uiId` from
 *    `tool_execution_start` is reused on end.
 *  - `agent_start` after a previous `agent_end` while `queuedCount > 0`
 *    re-marks `promptInFlight` so a follow-up chat / set_model on this
 *    tab queues correctly instead of being treated as a fresh idle
 *    prompt (cf. cancelRunningToolCards in `./tools.ts`).
 *  - `agent_end` always emits `response_end` so the frontend can release
 *    the turn UI, even on error.
 */

import {
  extractAgentEndError,
  isRetryableAgentEndError,
} from "../agent-errors";
import { logger } from "../logger";
import type { AethonAgentState, TabRecord } from "../state";
import { consumeBashTerminalSnapshot } from "../terminal-stream";
import {
  extractToolContent,
  summarizeToolArgs,
  toolCardPayload,
} from "../tool-card";
import { emitBashResult } from "./terminal";
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
  switch (event.type) {
    case "agent_start": {
      state.currentAgentTabId = tabId;
      state.turnStartTimes.set(tabId, Date.now());
      const model = rec.session.model ? modelKey(rec.session.model) : "unknown";
      turnLog.info(`start model=${model} tabId=${tabId}`);
      if (rec.queuedCount > 0) {
        rec.queuedCount -= 1;
        // The previous agent_end cleared promptInFlight, but pi has
        // already started the queue-drained turn — re-mark in-flight so
        // a follow-up chat / set_model on this tab queues correctly
        // instead of being treated as a fresh idle prompt.
        rec.promptInFlight = true;
        rec.agentEndFired = false;
        deps.send({
          type: "prompt_started",
          tabId,
          source: "queue",
          queued: rec.queuedCount,
        });
      }
      break;
    }
    case "message_update": {
      const ame = (
        event as { assistantMessageEvent?: { type?: string; delta?: string } }
      ).assistantMessageEvent;
      const channel =
        ame?.type === "thinking_delta" || ame?.type === "reasoning_delta"
          ? "thinking"
          : "text";
      if (
        ame?.type === "text_delta" ||
        ame?.type === "thinking_delta" ||
        ame?.type === "reasoning_delta"
      ) {
        const delta = ame.delta ?? "";
        if (delta) {
          const ts =
            (event as { message?: { timestamp?: number } }).message
              ?.timestamp ?? 0;
          const messageId = `text-${ts}`;
          deps.send({
            type: "response_delta",
            tabId,
            messageId,
            content: delta,
            channel,
          });
        }
      }
      break;
    }
    case "tool_execution_start": {
      const ev = event as {
        toolCallId: string;
        toolName: string;
        args: unknown;
      };
      const summary = summarizeToolArgs(ev.toolName, ev.args);
      const startedAt = Date.now();
      const uiId = `tool-${++rec.toolCardSeq}-${ev.toolCallId}`;
      rec.toolArgsCache.set(ev.toolCallId, {
        name: ev.toolName,
        summary,
        uiId,
        startedAt,
      });
      const payload = toolCardPayload({
        id: uiId,
        toolName: ev.toolName,
        argsSummary: summary,
        startedAt,
      });
      deps.send({ type: "a2ui", tabId, id: uiId, payload });
      if (ev.toolName === "bash") {
        const cmd = String(
          (ev.args as { command?: unknown } | undefined)?.command ?? "",
        );
        const echoed = cmd.replace(/\r?\n/g, "\r\n");
        deps.send({
          type: "terminal_output",
          tabId,
          content: `\r\n$ ${echoed}\r\n`,
        });
      }
      break;
    }
    case "tool_execution_update": {
      const ev = event as {
        toolCallId: string;
        toolName: string;
        args: unknown;
        partialResult: unknown;
      };
      if (ev.toolName === "bash") {
        let cached = rec.toolArgsCache.get(ev.toolCallId);
        if (!cached) {
          cached = {
            name: ev.toolName,
            summary: summarizeToolArgs(ev.toolName, ev.args),
            uiId: `tool-${++rec.toolCardSeq}-${ev.toolCallId}`,
          };
          rec.toolArgsCache.set(ev.toolCallId, cached);
        }
        const extracted = extractToolContent(ev.partialResult);
        const streamed = consumeBashTerminalSnapshot(
          extracted.text,
          cached.bashStream,
        );
        cached.bashStream = streamed.state;
        emitBashResult(deps, streamed.delta, tabId);
      }
      break;
    }
    case "tool_execution_end": {
      const ev = event as {
        toolCallId: string;
        toolName: string;
        result: unknown;
        isError?: boolean;
      };
      const cached = rec.toolArgsCache.get(ev.toolCallId);
      const uiId = cached?.uiId ?? `tool-${++rec.toolCardSeq}-${ev.toolCallId}`;
      const payload = toolCardPayload({
        id: uiId,
        toolName: ev.toolName,
        argsSummary: cached?.summary ?? "",
        result: ev.result,
        isError: ev.isError,
        ...(cached?.status !== undefined ? { status: cached.status } : {}),
        ...(cached?.startedAt !== undefined
          ? {
              startedAt: cached.startedAt,
              endedAt: cached.endedAt ?? Date.now(),
            }
          : {}),
      });
      deps.send({ type: "a2ui", tabId, id: uiId, payload });
      if (ev.toolName === "bash") {
        const extracted = extractToolContent(ev.result);
        const streamed = consumeBashTerminalSnapshot(
          extracted.text,
          cached?.bashStream,
        );
        emitBashResult(deps, streamed.delta, tabId);
        deps.send({ type: "terminal_output", tabId, content: "\r\n" });
      }
      rec.toolArgsCache.delete(ev.toolCallId);
      break;
    }
    case "agent_end": {
      const messages = (event as { messages?: unknown[] }).messages;
      const failedMessage = extractAgentEndError(messages);
      const retrying =
        (rec.session as { isRetrying?: boolean } | undefined)?.isRetrying === true;
      const retryableFailure =
        failedMessage !== undefined && isRetryableAgentEndError(failedMessage);
      const keepTurnOpenForRetry = retrying && retryableFailure;
      if (failedMessage && !keepTurnOpenForRetry) {
        deps.send({ type: "error", tabId, message: failedMessage });
      }
      const startMs = state.turnStartTimes.get(tabId);
      state.turnStartTimes.delete(tabId);
      const durationMs = startMs !== undefined ? Date.now() - startMs : -1;
      const modelStr = rec.session.model
        ? modelKey(rec.session.model)
        : "unknown";
      const lastAssistant = [
        ...((messages ?? []) as { role?: string; stopReason?: string }[]),
      ]
        .reverse()
        .find((m) => m.role === "assistant");
      const reason = lastAssistant?.stopReason ?? "unknown";
      const log = `end model=${modelStr} tabId=${tabId} durationMs=${durationMs} stopReason=${reason}`;
      if (reason === "error") {
        turnLog.warn(log);
      } else {
        turnLog.info(log);
      }
      for (const [toolCallId, cached] of rec.toolArgsCache) {
        if (cached.endedAt !== undefined) rec.toolArgsCache.delete(toolCallId);
      }
      if (!keepTurnOpenForRetry) {
        rec.agentEndFired = true;
        rec.promptInFlight = false;
        if (state.currentAgentTabId === tabId) {
          state.currentAgentTabId = undefined;
        }
        deps.send({ type: "response_end", tabId });
      }
      break;
    }
    case "auto_retry_start": {
      const ev = event as {
        attempt?: number;
        maxAttempts?: number;
        delayMs?: number;
        errorMessage?: string;
      };
      rec.promptInFlight = true;
      rec.agentEndFired = false;
      state.currentAgentTabId = tabId;
      deps.send({
        type: "notice",
        tabId,
        message: `Transient provider error; retrying ${
          ev.attempt ?? "?"
        }/${ev.maxAttempts ?? "?"} in ${Math.max(
          0,
          Math.round((ev.delayMs ?? 0) / 1000),
        )}s.`,
      });
      break;
    }
    case "auto_retry_end": {
      const ev = event as { success?: boolean; finalError?: string };
      if (!ev.success && ev.finalError) {
        deps.send({
          type: "error",
          tabId,
          message: `auto-retry exhausted: ${ev.finalError}`,
        });
        rec.agentEndFired = true;
        rec.promptInFlight = false;
        if (state.currentAgentTabId === tabId) {
          state.currentAgentTabId = undefined;
        }
        deps.send({ type: "response_end", tabId });
      }
      break;
    }
  }
}
