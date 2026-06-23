import { emitSessionEvent } from "../aethon-api-sessions";
import {
  addLiveContextUsageEstimate,
  emitContextUsageThrottled,
} from "../context-usage";
import type { AethonAgentState, TabRecord } from "../state";
import {
  textFromContent,
  thinkingFromContent,
} from "../session-history/shared";
import { modelKey } from "./utils";
import type { TabLifecycleDeps } from "./utils";

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

export function rollResponseMessage(rec: TabRecord): void {
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

function emitResponseSessionEvent(
  state: AethonAgentState,
  rec: TabRecord,
  tabId: string,
  messageId: string,
  previousMessageId: string | undefined,
): void {
  const message = {
    id: messageId,
    role: "agent" as const,
    ...(rec.session.model ? { model: modelKey(rec.session.model) } : {}),
    content: rec.activeResponseText ?? "",
    ...(rec.activeResponseText ? { text: rec.activeResponseText } : {}),
    ...(rec.activeResponseThinking
      ? { thinking: rec.activeResponseThinking }
      : {}),
  };
  if (previousMessageId !== messageId) {
    emitSessionEvent(state, "messageAppended", {
      sessionId: tabId,
      message,
    });
  } else {
    emitSessionEvent(state, "messageUpdated", {
      sessionId: tabId,
      messageId,
      message,
    });
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

export function handleResponseMessageUpdate(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  event: { type: string } & Record<string, unknown>,
): void {
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
      const previousMessageId = rec.activeResponseMessageId;
      const messageId = responseMessageId(rec, ame);
      deps.send({
        type: "response_delta",
        tabId,
        messageId,
        content: delta,
        channel,
        ...(rec.session.model ? { model: modelKey(rec.session.model) } : {}),
      });
      rememberResponseDelta(rec, channel, delta);
      emitResponseSessionEvent(
        state,
        rec,
        tabId,
        messageId,
        previousMessageId,
      );
      addLiveContextUsageEstimate(rec, delta);
      emitContextUsageThrottled(state, deps, tabId, rec);
    }
  }
}

export function emitFinalAssistantContent(
  state: AethonAgentState,
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

  const previousMessageId = rec.activeResponseMessageId;
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
      ...(rec.session.model ? { model: modelKey(rec.session.model) } : {}),
    });
    rememberResponseDelta(rec, "thinking", thinkingDelta);
    emitResponseSessionEvent(state, rec, tabId, messageId, previousMessageId);
  }
  const textDelta = missingSuffix(finalText, rec.activeResponseText);
  if (textDelta) {
    deps.send({
      type: "response_delta",
      tabId,
      messageId,
      content: textDelta,
      channel: "text",
      ...(rec.session.model ? { model: modelKey(rec.session.model) } : {}),
    });
    const beforeTextMessageId = thinkingDelta ? messageId : previousMessageId;
    rememberResponseDelta(rec, "text", textDelta);
    emitResponseSessionEvent(state, rec, tabId, messageId, beforeTextMessageId);
  }
}
