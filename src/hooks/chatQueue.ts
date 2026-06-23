import type { QueuedMessage, Tab } from "../types/tab";
import type { UseChatContext } from "./useChat";
import type { SendChatOptions } from "./chatTransport";

/** Patch `queuedMessages` and the derived `queueCount` together so the
 *  composer badge can't drift out of sync with the popover list. */
export function withQueue(tab: Tab, next: QueuedMessage[]): Tab {
  return { ...tab, queuedMessages: next, queueCount: next.length };
}

/** Tolerant accessor for tabs that pre-date the field. */
export function queueOf(tab: Tab): QueuedMessage[] {
  return tab.queuedMessages ?? [];
}

export interface ChatQueueController {
  editQueuedMessage: (
    tabId: string,
    messageId: string,
    content: string,
  ) => void;
  deleteQueuedMessage: (tabId: string, messageId: string) => void;
  steerQueuedMessage: (tabId: string, messageId: string) => Promise<void>;
  clearQueuedMessages: (tabId: string) => void;
}

export function createChatQueueController(
  ctx: Pick<UseChatContext, "stateRef" | "updateTab">,
  sendChat: (text: string, options?: SendChatOptions) => Promise<void>,
): ChatQueueController {
  const { stateRef, updateTab } = ctx;

  function editQueuedMessage(
    tabId: string,
    messageId: string,
    content: string,
  ) {
    updateTab(tabId, (tab) => {
      const current = queueOf(tab);
      if (current.length === 0) return tab;
      const idx = current.findIndex((m) => m.id === messageId);
      if (idx < 0) return tab;
      const next = current.slice();
      // Drop any hidden bridge text: a user-rewritten body supersedes the
      // original @file expansion, so dispatch exactly what they now see.
      next[idx] = { ...next[idx], content, bridgeText: undefined };
      return withQueue(tab, next);
    });
  }

  function deleteQueuedMessage(tabId: string, messageId: string) {
    updateTab(tabId, (tab) => {
      const current = queueOf(tab);
      if (current.length === 0) return tab;
      const next = current.filter((m) => m.id !== messageId);
      if (next.length === current.length) return tab;
      return withQueue(tab, next);
    });
  }

  function clearQueuedMessages(tabId: string) {
    updateTab(tabId, (tab) => {
      if (queueOf(tab).length === 0) return tab;
      return withQueue(tab, []);
    });
  }

  async function steerQueuedMessage(tabId: string, messageId: string) {
    const tab = ((stateRef.current.tabs as Tab[] | undefined) ?? []).find(
      (t) => t.id === tabId,
    );
    if (!tab) return;
    const entry = queueOf(tab).find((m) => m.id === messageId);
    if (!entry) return;
    // Pop the message from the queue and flip the spinner id in one render
    // commit so the popover row replaces itself with the spinner instead
    // of briefly showing nothing.
    updateTab(tabId, (t) => ({
      ...withQueue(
        t,
        queueOf(t).filter((m) => m.id !== messageId),
      ),
      queuedSteeringId: messageId,
    }));
    try {
      await sendChat(entry.content, {
        mode: "steer",
        tabId,
        attachments: entry.attachments,
        ...(entry.bridgeText ? { bridgeText: entry.bridgeText } : {}),
      });
    } finally {
      updateTab(tabId, (t) =>
        t.queuedSteeringId === messageId
          ? { ...t, queuedSteeringId: undefined }
          : t,
      );
    }
  }

  return {
    editQueuedMessage,
    deleteQueuedMessage,
    steerQueuedMessage,
    clearQueuedMessages,
  };
}
