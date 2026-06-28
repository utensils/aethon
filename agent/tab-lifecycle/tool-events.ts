import {
  addLiveContextUsageEstimate,
  emitContextUsageThrottled,
} from "../context-usage";
import { isSilentTool } from "../silent-tools";
import type { AethonAgentState, TabRecord } from "../state";
import { consumeBashTerminalSnapshot } from "../terminal-stream";
import {
  extractToolContent,
  summarizeToolArgs,
  toolCardPayload,
} from "../tool-card";
import { rollResponseMessage } from "./response-stream";
import { emitBashResult } from "./terminal";
import type { TabLifecycleDeps } from "./utils";

function currentToolRoot(state: AethonAgentState, tabId: string): string {
  return (
    state.tabProjectCwds?.get(tabId) ??
    state.currentProjectCwd ??
    state.userDir ??
    process.cwd()
  );
}

function summarizeToolResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 16_384);
  try {
    return JSON.stringify(result).slice(0, 16_384);
  } catch {
    return String(result).slice(0, 16_384);
  }
}

export function handleToolExecutionStart(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  event: { type: string } & Record<string, unknown>,
): void {
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
  // pi can re-emit tool_execution_start for the *same* toolCallId without an
  // intervening tool_execution_end — auto-retry of a wedged turn, codex replay,
  // etc. handleToolExecutionEnd deletes the cache entry, so a still-cached
  // toolCallId means this is a replay of an in-flight call: reuse the existing
  // card id + startedAt instead of minting a fresh card, otherwise the user
  // sees two "Running" copies of the same long-running command (the original is
  // orphaned because the single end event only closes the newest uiId).
  const existing = rec.toolArgsCache.get(ev.toolCallId);
  const startedAt = existing?.startedAt ?? Date.now();
  const uiId = existing?.uiId ?? `tool-${++rec.toolCardSeq}-${ev.toolCallId}`;
  const rootPath = existing?.rootPath ?? currentToolRoot(state, tabId);
  rec.toolArgsCache.set(ev.toolCallId, {
    ...existing,
    name: ev.toolName,
    summary,
    uiId,
    args: ev.args,
    rootPath,
    startedAt,
  });
  const payload = toolCardPayload({
    id: uiId,
    toolName: ev.toolName,
    argsSummary: summary,
    args: ev.args,
    rootPath,
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
}

export function handleToolExecutionUpdate(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  event: { type: string } & Record<string, unknown>,
): void {
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
        args: ev.args,
        rootPath: currentToolRoot(state, tabId),
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
  } else if (ev.toolName === "task" || ev.toolName === "task_batch") {
    let cached = rec.toolArgsCache.get(ev.toolCallId);
    if (!cached) {
      cached = {
        name: ev.toolName,
        summary: summarizeToolArgs(ev.toolName, ev.args),
        uiId: `tool-${++rec.toolCardSeq}-${ev.toolCallId}`,
        args: ev.args,
        rootPath: currentToolRoot(state, tabId),
        startedAt: Date.now(),
      };
      rec.toolArgsCache.set(ev.toolCallId, cached);
    }
    const payload = toolCardPayload({
      id: cached.uiId,
      toolName: ev.toolName,
      argsSummary: cached.summary,
      args: cached.args ?? ev.args,
      rootPath: cached.rootPath,
      result: ev.partialResult,
      startedAt: cached.startedAt,
    });
    deps.send({ type: "a2ui", tabId, id: cached.uiId, payload });
    const extracted = extractToolContent(ev.partialResult);
    cached.taskPartialText = extracted.text;
    const streamed = consumeBashTerminalSnapshot(
      extracted.text,
      cached.taskPartialStream,
    );
    cached.taskPartialStream = streamed.state;
    addLiveContextUsageEstimate(rec, streamed.delta);
    emitContextUsageThrottled(state, deps, tabId, rec);
  }
}

export function handleToolExecutionEnd(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  event: { type: string } & Record<string, unknown>,
): void {
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
    args: cached?.args,
    rootPath: cached?.rootPath,
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
}
