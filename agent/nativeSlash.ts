import { mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AethonAgentState } from "./state";
import type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";
import { emitGlobalReady } from "./dispatcherTypes";
import { normalizeSessionLabel, writeSessionLabel } from "./session-history";
import { ensureTab, modelKey, tabSessionDir } from "./tab-lifecycle";

interface NativeContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

interface NativeSessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: NativeContextUsage;
}

function formatInt(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n)
    ? n.toLocaleString("en-US")
    : "unknown";
}

function formatCost(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n)
    ? `$${n.toFixed(4)}`
    : "$0.0000";
}

export function exportTargetForSlashCommand(
  state: AethonAgentState,
  args: unknown,
): { path: string; jsonl: boolean } {
  const exportsDir = join(state.userDir, "exports");
  const fallbackName = `session-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
  const raw = typeof args === "string" ? args.trim() : "";
  let fileName = raw ? basename(raw.replace(/\\/g, "/")) : fallbackName;
  if (!fileName || fileName === "." || fileName === "..") {
    fileName = fallbackName;
  }
  const ext = extname(fileName).toLowerCase();
  const jsonl = ext === ".jsonl";
  if (!jsonl && ext !== ".html" && ext !== ".htm") {
    fileName = `${fileName}.html`;
  }
  return { path: join(exportsDir, fileName), jsonl };
}

export function formatContextUsageMessage(
  usage: NativeContextUsage | undefined,
  model: string | undefined,
): string {
  const lines = ["## Context"];
  if (model) lines.push(`- Model: ${model}`);
  if (!usage) {
    lines.push("- Usage: unknown");
    lines.push(
      "- Note: pi reports context usage after the first assistant response for the selected model.",
    );
    return lines.join("\n");
  }
  lines.push(`- Window: ${formatInt(usage.contextWindow)} tokens`);
  if (usage.tokens === null || usage.percent === null) {
    lines.push("- Used: unknown");
    lines.push(
      "- Note: usage is unknown until an assistant response after the latest compaction.",
    );
    return lines.join("\n");
  }
  const remaining = Math.max(usage.contextWindow - usage.tokens, 0);
  lines.push(
    `- Used: ${formatInt(usage.tokens)} tokens (${usage.percent.toFixed(1)}%)`,
  );
  lines.push(`- Remaining: ${formatInt(remaining)} tokens`);
  return lines.join("\n");
}

export function formatSessionStatsMessage(
  stats: NativeSessionStats,
  sessionName: string | undefined,
): string {
  const lines = ["## Session"];
  if (sessionName) lines.push(`- Name: ${sessionName}`);
  lines.push(`- File: ${stats.sessionFile ?? "In-memory"}`);
  lines.push(`- ID: ${stats.sessionId}`);
  lines.push("");
  lines.push("## Messages");
  lines.push(`- User: ${formatInt(stats.userMessages)}`);
  lines.push(`- Assistant: ${formatInt(stats.assistantMessages)}`);
  lines.push(`- Tool Calls: ${formatInt(stats.toolCalls)}`);
  lines.push(`- Tool Results: ${formatInt(stats.toolResults)}`);
  lines.push(`- Total: ${formatInt(stats.totalMessages)}`);
  lines.push("");
  lines.push("## Tokens");
  lines.push(`- Input: ${formatInt(stats.tokens.input)}`);
  lines.push(`- Output: ${formatInt(stats.tokens.output)}`);
  if (stats.tokens.cacheRead > 0) {
    lines.push(`- Cache Read: ${formatInt(stats.tokens.cacheRead)}`);
  }
  if (stats.tokens.cacheWrite > 0) {
    lines.push(`- Cache Write: ${formatInt(stats.tokens.cacheWrite)}`);
  }
  lines.push(`- Total: ${formatInt(stats.tokens.total)}`);
  lines.push("");
  lines.push("## Cost");
  lines.push(`- Total: ${formatCost(stats.cost)}`);
  return lines.join("\n");
}

export async function handleNativeSlashCommand(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const name = typeof msg.name === "string" ? msg.name : "";
  const tabId = msg.tabId ?? "default";
  if (!name) {
    deps.send({
      type: "native_slash_result",
      tabId,
      command: "unknown",
      kind: "error",
      message: "Native slash command: missing name",
    });
    return;
  }
  const tab = await ensureTab(state, deps, tabId);
  const command = name.toLowerCase();
  switch (command) {
    case "context": {
      const usage = (
        tab.session as {
          getContextUsage?: () => NativeContextUsage | undefined;
        }
      ).getContextUsage?.();
      deps.send({
        type: "native_slash_result",
        tabId,
        command,
        message: formatContextUsageMessage(
          usage,
          tab.session.model ? modelKey(tab.session.model) : undefined,
        ),
      });
      return;
    }
    case "session": {
      const stats = (
        tab.session as { getSessionStats?: () => NativeSessionStats }
      ).getSessionStats?.();
      if (!stats) {
        deps.send({
          type: "native_slash_result",
          tabId,
          command,
          kind: "error",
          message: "Session statistics are unavailable.",
        });
        return;
      }
      const sessionName = (
        tab.session.sessionManager as {
          getSessionName?: () => string | undefined;
        }
      ).getSessionName?.();
      deps.send({
        type: "native_slash_result",
        tabId,
        command,
        message: formatSessionStatsMessage(stats, sessionName),
      });
      return;
    }
    case "compact": {
      if (tab.promptInFlight) {
        deps.send({
          type: "native_slash_result",
          tabId,
          command,
          kind: "error",
          message:
            "Compaction rejected: stop the current prompt before compacting context.",
        });
        return;
      }
      try {
        const customInstructions =
          typeof msg.args === "string" && msg.args.trim().length > 0
            ? msg.args.trim()
            : undefined;
        const result = await tab.session.compact(customInstructions);
        const tokensBefore =
          typeof result?.tokensBefore === "number"
            ? ` ${formatInt(result.tokensBefore)} tokens were summarized.`
            : "";
        deps.send({
          type: "native_slash_result",
          tabId,
          command,
          message: `Context compacted.${tokensBefore}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({
          type: "native_slash_result",
          tabId,
          command,
          kind: "error",
          message: `Compaction failed: ${message}`,
        });
      }
      return;
    }
    case "name": {
      const nextName =
        typeof msg.args === "string" ? normalizeSessionLabel(msg.args) : "";
      if (!nextName) {
        const current = (
          tab.session.sessionManager as {
            getSessionName?: () => string | undefined;
          }
        ).getSessionName?.();
        deps.send({
          type: "native_slash_result",
          tabId,
          command,
          message: current
            ? `Session name: ${current}`
            : "Session name is not set. Usage: `/name <name>`",
        });
        return;
      }
      tab.session.setSessionName(nextName);
      try {
        await writeSessionLabel(tabSessionDir(state, tabId), nextName);
      } catch {
        /* pi session name still succeeded; label replay is best effort */
      }
      deps.send({
        type: "native_slash_result",
        tabId,
        command,
        message: `Session name set: ${nextName}`,
      });
      emitGlobalReady(state, deps);
      return;
    }
    case "export": {
      try {
        const target = exportTargetForSlashCommand(state, msg.args);
        await mkdir(join(state.userDir, "exports"), { recursive: true });
        const path = target.jsonl
          ? tab.session.exportToJsonl(target.path)
          : await tab.session.exportToHtml(target.path);
        deps.send({
          type: "native_slash_result",
          tabId,
          command,
          message: `Session exported to: ${path}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({
          type: "native_slash_result",
          tabId,
          command,
          kind: "error",
          message: `Export failed: ${message}`,
        });
      }
      return;
    }
    default:
      deps.send({
        type: "native_slash_result",
        tabId,
        command,
        kind: "error",
        message: `Unknown native slash command: /${name}`,
      });
  }
}
