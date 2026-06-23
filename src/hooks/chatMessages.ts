import type { MutableRefObject } from "react";

import type { ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";
import type { UseChatContext } from "./useChat";

export interface ChatMessageController {
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  appendOrAmendAgentText: (
    delta: string,
    messageId?: string,
    tabId?: string,
    channel?: "text" | "thinking",
  ) => void;
  appendSystem: (text: string) => void;
  clearChat: () => void;
  setStatusFlags: (
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) => void;
}

export function useChatMessageController(
  ctx: Pick<
    UseChatContext,
    | "setState"
    | "stateRef"
    | "updateTab"
    | "updateActiveTab"
    | "persistLocalChatMessage"
  >,
  activeResponseIdRef: MutableRefObject<string | null>,
): ChatMessageController {
  const {
    setState,
    stateRef,
    updateTab,
    updateActiveTab,
    persistLocalChatMessage,
  } = ctx;

  // Append a chat message, or replace in place if a message with the same
  // id already exists. This is what lets the bridge stream "running…" tool
  // cards and update them with the final result without duplicating bubbles.
  // tabId routes to the right tab record; defaults to the active tab so
  // legacy callers that pre-date the multi-tab refactor stay correct.
  function appendMessage(msg: ChatMessage, tabId?: string) {
    const id =
      tabId ??
      (stateRef.current.activeTabId as string | undefined) ??
      "default";
    updateTab(id, (tab) => {
      const messages = [...tab.messages];
      const idx = messages.findIndex((m) => m.id === msg.id);
      if (idx >= 0) {
        messages[idx] = msg;
      } else if (typeof msg.createdAt === "number") {
        const insertAt = messages.findIndex(
          (m) =>
            typeof m.createdAt === "number" && m.createdAt > msg.createdAt!,
        );
        if (insertAt >= 0) {
          messages.splice(insertAt, 0, msg);
        } else {
          messages.push(msg);
        }
      } else {
        messages.push(msg);
      }
      return { ...tab, messages };
    });
  }

  // Append a streaming text delta to its bubble. When the bridge supplies a
  // stable `messageId`, look up the bubble by id anywhere in the array —
  // this keeps deltas for one streamed assistant segment in one bubble while
  // allowing the bridge to start a fresh bubble after tool cards. Without a
  // messageId (legacy bridges), fall back to the previous "is it the last message?"
  // behavior tracked via activeResponseIdRef.
  function appendOrAmendAgentText(
    delta: string,
    messageId?: string,
    tabId?: string,
    channel: "text" | "thinking" = "text",
  ) {
    const id =
      tabId ??
      (stateRef.current.activeTabId as string | undefined) ??
      "default";
    updateTab(id, (tab) => {
      const messages = [...tab.messages];
      if (messageId) {
        const idx = messages.findIndex((m) => m.id === messageId);
        let nextMessage: ChatMessage;
        if (idx >= 0) {
          nextMessage = {
            ...messages[idx],
            createdAt: messages[idx].createdAt ?? Date.now(),
            [channel]: (messages[idx][channel] ?? "") + delta,
          };
          messages[idx] = nextMessage;
        } else {
          nextMessage = {
            id: messageId,
            role: "agent",
            createdAt: Date.now(),
            [channel]: delta,
          };
          messages.push(nextMessage);
        }
        activeResponseIdRef.current = messageId;
        persistLocalChatMessage(nextMessage, id);
        return { ...tab, messages };
      }
      const activeId = activeResponseIdRef.current;
      const last = messages[messages.length - 1];
      if (activeId && last && last.id === activeId && last.role === "agent") {
        const nextMessage = {
          ...last,
          createdAt: last.createdAt ?? Date.now(),
          [channel]: (last[channel] ?? "") + delta,
        };
        messages[messages.length - 1] = nextMessage;
        persistLocalChatMessage(nextMessage, id);
      } else {
        const newId = crypto.randomUUID();
        activeResponseIdRef.current = newId;
        const nextMessage = {
          id: newId,
          role: "agent" as const,
          createdAt: Date.now(),
          [channel]: delta,
        };
        messages.push(nextMessage);
        persistLocalChatMessage(nextMessage, id);
      }
      return { ...tab, messages };
    });
  }

  function setStatusFlags(
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) {
    setState((prev) => ({ ...prev, ...flags }));
  }

  function appendSystem(text: string) {
    appendMessage({
      id: crypto.randomUUID(),
      role: "system",
      text,
      createdAt: Date.now(),
    });
  }

  function clearChat() {
    // Clears the active tab's in-memory message list. Pi's JSONL file is
    // managed by the session itself; clearing chat here only affects the UI
    // view for this session slot. The agent will continue writing new turns
    // to the same session file, so a restart still sees prior history — this
    // is intentional (Cmd+K is a "clean view" action, not a "delete history"
    // action). If the user wants to start fresh, they open a new tab.
    updateActiveTab((tab: Tab) => ({ ...tab, messages: [] }));
  }

  return {
    appendMessage,
    appendOrAmendAgentText,
    appendSystem,
    clearChat,
    setStatusFlags,
  };
}
