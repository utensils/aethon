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
import type { TabRecord } from "../state";
import type { TabLifecycleDeps } from "./utils";

const turnLog = logger.scope("turn");

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
