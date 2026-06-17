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
 *  - Streaming assistant text/thinking ids are synthetic per assistant
 *    segment and roll at tool boundaries; never key them from pi event
 *    timestamps, which can point at earlier transcript records.
 */

import {
  extractAgentEndError,
  isRetryableAgentEndError,
} from "../agent-errors";
import { logger } from "../logger";
import type { AethonAgentState, TabRecord } from "../state";
import {
  textFromContent,
  thinkingFromContent,
} from "../session-history/shared";
import { consumeBashTerminalSnapshot } from "../terminal-stream";
import {
  extractToolContent,
  summarizeToolArgs,
  toolCardPayload,
} from "../tool-card";
import { emitBashResult } from "./terminal";
import { cancelAethonRetry, scheduleAethonRetry } from "./retry";
import type { TabLifecycleDeps } from "./utils";
import { modelKey } from "./utils";
import { supportsCodexFastMode } from "../codex-fast-mode";
import { isSilentTool } from "../silent-tools";
import {
  addLiveContextUsageEstimate,
  clearLiveContextUsageEstimate,
  emitContextUsage,
  emitContextUsageThrottled,
} from "../context-usage";

const turnLog = logger.scope("turn");

function assistantEventMessageId(ame: {
  id?: unknown;
  messageId?: unknown;
}): string | undefined {
  if (typeof ame.messageId === "string" && ame.messageId.length > 0) {
    return ame.messageId;
  }
  if (typeof ame.id === "string" && ame.id.length > 0) return ame.id;
  return undefined;
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 96) || "assistant";
}

function startResponseSegment(
  rec: TabRecord,
  canonical: string | undefined,
): string {
  rec.responseMessageSeq = (rec.responseMessageSeq ?? 0) + 1;
  rec.activeResponseCanonicalId = canonical;
  rec.activeResponseMessageId = canonical
    ? `text-${safeIdPart(canonical)}-${rec.responseMessageSeq}`
    : `text-${Date.now()}-${rec.responseMessageSeq}`;
  rec.activeResponseText = "";
  rec.activeResponseThinking = "";
  return rec.activeResponseMessageId;
}

function responseMessageId(
  rec: TabRecord,
  ame: { id?: unknown; messageId?: unknown },
): string {
  // Do not derive identity from the outer message_update.message timestamp
  // (or its surrounding record). In practice that metadata can refer to an
  // earlier transcript record during streaming, causing later thinking deltas
  // to amend an older bubble and render above intervening tool cards.
  const canonical = assistantEventMessageId(ame);
  if (
    rec.activeResponseMessageId &&
    rec.activeResponseCanonicalId === canonical
  ) {
    return rec.activeResponseMessageId;
  }
  // Even when pi supplies a canonical assistant id, use a segment-scoped UI
  // id. Some providers use one canonical id for an assistant message that
  // spans tool calls; reusing it after a tool boundary would amend the
  // pre-tool bubble above the tool card.
  return startResponseSegment(rec, canonical);
}

function rollResponseMessage(rec: TabRecord): void {
  rec.activeResponseMessageId = undefined;
  rec.activeResponseCanonicalId = undefined;
  rec.activeResponseText = undefined;
  rec.activeResponseThinking = undefined;
}

function rememberResponseDelta(
  rec: TabRecord,
  channel: "text" | "thinking",
  delta: string,
): void {
  if (channel === "thinking") {
    rec.activeResponseThinking = (rec.activeResponseThinking ?? "") + delta;
  } else {
    rec.activeResponseText = (rec.activeResponseText ?? "") + delta;
  }
}

function assistantMessageCanonicalId(message: {
  id?: unknown;
  messageId?: unknown;
}): string | undefined {
  return assistantEventMessageId(message);
}

function missingSuffix(
  finalContent: string,
  streamedContent: string | undefined,
): string {
  if (!finalContent) return "";
  const streamed = streamedContent ?? "";
  if (!streamed) return finalContent;
  if (finalContent === streamed) return "";
  if (finalContent.startsWith(streamed))
    return finalContent.slice(streamed.length);
  if (streamed.includes(finalContent)) return "";
  return finalContent;
}

function emitFinalAssistantContent(
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  assistant:
    | ({ role?: unknown; content?: unknown } & {
        id?: unknown;
        messageId?: unknown;
      })
    | undefined,
): void {
  if (!assistant || assistant.role !== "assistant") return;
  const finalThinking = thinkingFromContent(assistant.content);
  const finalText = textFromContent(assistant.content);
  if (!finalThinking && !finalText) return;

  const messageId =
    rec.activeResponseMessageId ??
    startResponseSegment(rec, assistantMessageCanonicalId(assistant));
  const thinkingDelta = missingSuffix(
    finalThinking,
    rec.activeResponseThinking,
  );
  if (thinkingDelta) {
    deps.send({
      type: "response_delta",
      tabId,
      messageId,
      content: thinkingDelta,
      channel: "thinking",
    });
    rememberResponseDelta(rec, "thinking", thinkingDelta);
  }
  const textDelta = missingSuffix(finalText, rec.activeResponseText);
  if (textDelta) {
    deps.send({
      type: "response_delta",
      tabId,
      messageId,
      content: textDelta,
      channel: "text",
    });
    rememberResponseDelta(rec, "text", textDelta);
  }
}

function compactionNotice(
  event: { type: string } & Record<string, unknown>,
): { message: string; busy?: true } | undefined {
  const type = event.type.toLowerCase();
  if (!type.includes("compact")) return undefined;
  if (type.includes("start") || type.includes("begin")) {
    return { message: "Compacting context...", busy: true };
  }
  if (type.includes("fail") || type.includes("error")) {
    const reason =
      typeof event.error === "string"
        ? event.error
        : typeof event.message === "string"
          ? event.message
          : "unknown error";
    return { message: `Context compaction failed: ${reason}` };
  }
  if (
    type.includes("end") ||
    type.includes("finish") ||
    type.includes("complete") ||
    type.includes("success")
  ) {
    const tokensBefore =
      typeof event.tokensBefore === "number" &&
      Number.isFinite(event.tokensBefore)
        ? ` · ${event.tokensBefore.toLocaleString("en-US")} tokens summarized`
        : "";
    return { message: `Context compacted${tokensBefore}` };
  }
  return undefined;
}

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

  switch (event.type) {
    case "agent_start": {
      rollResponseMessage(rec);
      clearLiveContextUsageEstimate(rec);
      state.currentAgentTabId = tabId;
      state.turnStartTimes.set(tabId, Date.now());
      emitContextUsage(state, deps, tabId, rec);
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
          deps.send({
            type: "response_delta",
            tabId,
            messageId: responseMessageId(rec, ame),
            content: delta,
            channel,
          });
          rememberResponseDelta(rec, channel, delta);
          addLiveContextUsageEstimate(rec, delta);
          emitContextUsageThrottled(state, deps, tabId, rec);
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
      if (isSilentTool(ev.toolName)) {
        rec.toolArgsCache.delete(ev.toolCallId);
        return;
      }
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
      addLiveContextUsageEstimate(rec, `${ev.toolName} ${summary}`);
      emitContextUsageThrottled(state, deps, tabId, rec);
      rollResponseMessage(rec);
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
      if (isSilentTool(ev.toolName)) {
        return;
      }
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
        addLiveContextUsageEstimate(rec, streamed.delta);
        emitContextUsageThrottled(state, deps, tabId, rec);
      } else if (ev.toolName === "task") {
        let cached = rec.toolArgsCache.get(ev.toolCallId);
        if (!cached) {
          cached = {
            name: ev.toolName,
            summary: summarizeToolArgs(ev.toolName, ev.args),
            uiId: `tool-${++rec.toolCardSeq}-${ev.toolCallId}`,
            startedAt: Date.now(),
          };
          rec.toolArgsCache.set(ev.toolCallId, cached);
        }
        const payload = toolCardPayload({
          id: cached.uiId,
          toolName: ev.toolName,
          argsSummary: cached.summary,
          result: ev.partialResult,
          startedAt: cached.startedAt,
        });
        deps.send({ type: "a2ui", tabId, id: cached.uiId, payload });
        const extracted = extractToolContent(ev.partialResult);
        const streamed = consumeBashTerminalSnapshot(
          extracted.text,
          cached.taskPartialStream,
        );
        cached.taskPartialStream = streamed.state;
        addLiveContextUsageEstimate(rec, streamed.delta);
        emitContextUsageThrottled(state, deps, tabId, rec);
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
      if (isSilentTool(ev.toolName)) {
        rec.toolArgsCache.delete(ev.toolCallId);
        return;
      }
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
        addLiveContextUsageEstimate(rec, streamed.delta);
        deps.send({ type: "terminal_output", tabId, content: "\r\n" });
      } else {
        addLiveContextUsageEstimate(rec, summarizeToolResult(ev.result));
      }
      rec.toolArgsCache.delete(ev.toolCallId);
      rollResponseMessage(rec);
      emitContextUsageThrottled(state, deps, tabId, rec);
      break;
    }
    case "agent_end": {
      const messages = (event as { messages?: unknown[] }).messages;
      const failedMessage = extractAgentEndError(messages);
      const retrying =
        (rec.session as { isRetrying?: boolean } | undefined)?.isRetrying ===
        true;
      const retryableFailure =
        failedMessage !== undefined && isRetryableAgentEndError(failedMessage);
      const keepTurnOpenForRetry =
        retryableFailure &&
        (retrying || scheduleAethonRetry(state, deps, rec, tabId));
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
        ...((messages ?? []) as Array<{
          role?: string;
          stopReason?: string;
          content?: unknown;
          id?: unknown;
          messageId?: unknown;
        }>),
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
        cancelAethonRetry(rec);
        rec.agentEndFired = true;
        rec.promptInFlight = false;
        if (state.currentAgentTabId === tabId) {
          state.currentAgentTabId = undefined;
        }
        emitFinalAssistantContent(deps, rec, tabId, lastAssistant);
        rollResponseMessage(rec);
        clearLiveContextUsageEstimate(rec);
        emitContextUsage(state, deps, tabId, rec);
        // Back-fill pi entry ids onto the just-streamed messages so the
        // rollback / fork affordances work without a reload.
        emitEntryIds(deps, rec, tabId);
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
      break;
    }
    case "auto_retry_end": {
      const ev = event as { success?: boolean; finalError?: string };
      cancelAethonRetry(rec);
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
        rollResponseMessage(rec);
        deps.send({ type: "response_end", tabId });
      }
      break;
    }
  }
}

function summarizeToolResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 16_384);
  try {
    return JSON.stringify(result).slice(0, 16_384);
  } catch {
    return String(result).slice(0, 16_384);
  }
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
