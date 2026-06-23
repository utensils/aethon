/**
 * Tool-card cancellation — the reload-sentinel guarantee. When the user
 * aborts a turn (or extension reload drains it), pi may terminate before
 * `tool_execution_end` reaches us. Re-emitting the same tool-card id
 * with `endedAt` freezes the frontend clock immediately; if pi later
 * sends the real end event, that result updates the same card instead
 * of duplicating it.
 *
 * The "extension drops never abort the user's LLM turn" contract from
 * CLAUDE.md is upheld here: cancelled cards always set `status`
 * + `endedAt`, leaving the bridge's later `tool_execution_end` handler
 * to update the same `uiId`.
 */

import { logger } from "../logger";
import { toolCardPayload } from "../tool-card";
import type { AethonAgentState, TabRecord } from "../state";
import {
  appendSyntheticSubagentToolResults,
  findSessionFileMatchingCwd,
  isSubagentToolName,
  latestSessionLog,
  syntheticSubagentToolResultMessage,
  type SyntheticSubagentToolResult,
} from "../session-history";
import { tabSessionDir, type TabLifecycleDeps } from "./utils";

const turnLog = logger.scope("turn");
const subagentLog = logger.scope("subagent");

interface ToolResultSessionState {
  agent?: {
    state?: {
      messages?: unknown[];
    };
  };
  sessionManager?: {
    appendMessage?: (message: unknown) => unknown;
    getEntries?: () => unknown[];
  };
}

function hasToolResultMessage(
  messages: readonly unknown[],
  toolCallId: string,
): boolean {
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const record = message as Record<string, unknown>;
    return record.role === "toolResult" && record.toolCallId === toolCallId;
  });
}

function sessionManagerHasToolResult(
  session: ToolResultSessionState,
  toolCallId: string,
): boolean {
  const entries = session.sessionManager?.getEntries?.();
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const message = (entry as Record<string, unknown>).message;
    if (!message || typeof message !== "object") return false;
    const record = message as Record<string, unknown>;
    return record.role === "toolResult" && record.toolCallId === toolCallId;
  });
}

function appendLiveSyntheticToolResult(
  rec: TabRecord,
  result: SyntheticSubagentToolResult,
): boolean {
  const session = rec.session as ToolResultSessionState;
  const message = syntheticSubagentToolResultMessage(result);
  const messages = session.agent?.state?.messages;
  if (
    Array.isArray(messages) &&
    !hasToolResultMessage(messages, result.toolCallId)
  ) {
    messages.push(message);
  }
  const appendMessage = session.sessionManager?.appendMessage;
  if (
    typeof appendMessage === "function" &&
    !sessionManagerHasToolResult(session, result.toolCallId)
  ) {
    appendMessage.call(session.sessionManager, message);
    return true;
  }
  return false;
}

async function persistSyntheticToolResults(
  state: AethonAgentState,
  tabId: string,
  results: SyntheticSubagentToolResult[],
): Promise<void> {
  if (results.length === 0) return;
  const dir = tabSessionDir(state, tabId);
  const cwd =
    state.tabProjectCwds.get(tabId) ?? state.currentProjectCwd ?? undefined;
  const matching = cwd ? await findSessionFileMatchingCwd(dir, cwd) : undefined;
  const fallback =
    !matching && tabId !== "default" ? await latestSessionLog(dir) : undefined;
  const path = matching ?? fallback?.path;
  if (!path) return;
  await appendSyntheticSubagentToolResults(path, results);
}

export function synthesizeCancelledSubagentToolResults(
  state: AethonAgentState,
  rec: TabRecord,
  tabId: string,
): number {
  const results: SyntheticSubagentToolResult[] = [];
  const rawPersistResults: SyntheticSubagentToolResult[] = [];
  for (const [toolCallId, cached] of rec.toolArgsCache) {
    if (
      cached.status !== "cancelled" ||
      cached.syntheticResultEmitted === true ||
      !isSubagentToolName(cached.name)
    ) {
      continue;
    }
    const result = {
      toolCallId,
      toolName: cached.name,
      ...(cached.taskPartialText
        ? { partialText: cached.taskPartialText }
        : {}),
    };
    const persistedThroughSessionManager = appendLiveSyntheticToolResult(
      rec,
      result,
    );
    cached.syntheticResultEmitted = true;
    results.push(result);
    if (!persistedThroughSessionManager) rawPersistResults.push(result);
  }
  if (rawPersistResults.length > 0) {
    void persistSyntheticToolResults(state, tabId, rawPersistResults).catch(
      (err: unknown) => {
        subagentLog.warn(
          `failed to persist synthetic subagent tool result tabId=${tabId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  }
  return results.length;
}

/** Stop visible timers for tools that were in-flight when the user aborted.
 *  Pi normally emits tool_execution_end, but abort paths can terminate the
 *  turn before that event reaches us. Re-emitting the same tool-card id with
 *  endedAt freezes the frontend clock immediately; if pi later sends the real
 *  end event, that result updates the same card instead of duplicating it. */
export function cancelRunningToolCards(
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
): number {
  const endedAt = Date.now();
  let count = 0;
  for (const [toolCallId, cached] of rec.toolArgsCache) {
    if (cached.startedAt === undefined || cached.endedAt !== undefined) {
      continue;
    }
    cached.endedAt = endedAt;
    cached.status = "cancelled";
    count += 1;
    const payload = toolCardPayload({
      id: cached.uiId,
      toolName: cached.name,
      argsSummary: cached.summary,
      args: cached.args,
      rootPath: cached.rootPath,
      result: "Cancelled by user.",
      status: "cancelled",
      startedAt: cached.startedAt,
      endedAt,
    });
    deps.send({ type: "a2ui", tabId, id: cached.uiId, payload });
    if (cached.name === "bash") {
      deps.send({
        type: "terminal_output",
        tabId,
        content: "\r\n[command cancelled]\r\n",
      });
    }
    turnLog.debug(`cancelled running tool-card ${toolCallId} tabId=${tabId}`);
  }
  return count;
}
