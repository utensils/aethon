import { summarizeToolArgs } from "../tool-card";
import type {
  SubagentRunDetails,
  SubagentTaskDeps,
} from "./task-params";

export interface SubagentEventCallbacks {
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  onToolStart: (toolName: string, toolSummary: string) => void;
  onToolEnd: (toolName: string, isError: boolean) => void;
  onEnd: (messages: unknown[]) => void;
}

/** Translate the subagent session's pi events into the streaming callbacks. */
export function handleSubagentEvent(
  event: { type: string } & Record<string, unknown>,
  cb: SubagentEventCallbacks,
): void {
  switch (event.type) {
    case "message_update": {
      const ame = (
        event as { assistantMessageEvent?: { type?: string; delta?: string } }
      ).assistantMessageEvent;
      const delta = ame?.delta ?? "";
      if (!delta) break;
      if (ame?.type === "text_delta") cb.onText(delta);
      else if (
        ame?.type === "thinking_delta" ||
        ame?.type === "reasoning_delta"
      ) {
        cb.onThinking(delta);
      }
      break;
    }
    case "tool_execution_start": {
      const ev = event as { toolName?: string; args?: unknown };
      const toolName = ev.toolName ?? "tool";
      cb.onToolStart(toolName, summarizeToolArgs(toolName, ev.args));
      break;
    }
    case "tool_execution_end": {
      const ev = event as { toolName?: string; isError?: boolean };
      cb.onToolEnd(ev.toolName ?? "tool", ev.isError === true);
      break;
    }
    case "agent_end": {
      const ev = event as { messages?: unknown[] };
      cb.onEnd(ev.messages ?? []);
      break;
    }
  }
}

/** Pull the last assistant message's text out of an agent_end `messages` array
 *  (fallback when no text deltas were captured). */
export function extractLastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message?.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) =>
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string"
            ? (block as { text: string }).text
            : "",
        )
        .join("");
      if (text) return text;
    }
  }
  return "";
}

export interface ProgressInfo {
  phase:
    | "start"
    | "text"
    | "thinking"
    | "tool_start"
    | "tool_end"
    | "done"
    | "error";
  delta?: string;
  toolName?: string;
  toolSummary?: string;
  isError?: boolean;
  error?: string;
}

export interface BatchProgressMeta {
  batchItemId: string;
  batchIndex: number;
}

export function emitProgress(
  deps: SubagentTaskDeps,
  parentTabId: string,
  callId: string,
  details: SubagentRunDetails,
  info: ProgressInfo,
  batch?: BatchProgressMeta,
): void {
  deps.send({
    type: "subagent_progress",
    tabId: parentTabId,
    parentCallId: callId,
    subagent: details.subagent,
    model: details.model,
    ...(batch
      ? { batchItemId: batch.batchItemId, batchIndex: batch.batchIndex }
      : {}),
    ...info,
  });
}
