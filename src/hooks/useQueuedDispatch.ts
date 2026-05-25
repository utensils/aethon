import { useEffect, useRef } from "react";
import type { Tab } from "../types/tab";

/**
 * Drains client-held queues. Watches every agent tab's `waiting` flag;
 * when it transitions to false and the tab still has queued messages,
 * the head pops and ships through `sendChat(..., { mode: "normal" })`.
 *
 * Coupling notes:
 *
 * - The hook pops the head ONLY — it deliberately does NOT pre-flip
 *   `waiting` to true. `sendChat`'s normal-dispatch path is what flips
 *   waiting; the pop + sendChat's three setState calls batch into a
 *   single render commit, so the composer doesn't flash Send between
 *   turns. Pre-flipping waiting here breaks the drain: `sendChat`
 *   reads `stateRef` synchronously, would see the tab as busy, and
 *   would route the popped message right back into the queue with a
 *   new id (caught by peer-review P1).
 * - `dispatching` tracks the tabs that are currently mid-dispatch
 *   (sendChat is async). It guards against the effect running again
 *   while sendChat is awaiting and double-firing the same head.
 * - `queuedSteeringId` blocks the drain while a manual steer is in
 *   flight, so a user mashing Send-next-and-Steer doesn't fire two
 *   chat sends at once.
 * - The hook intentionally only inspects `kind === "agent"` tabs;
 *   shell and editor tabs have queue arrays only because they share
 *   the Tab interface.
 */
export interface UseQueuedDispatchParams {
  tabs: Tab[];
  sendChat: (
    text: string,
    options?: { mode?: "normal" | "steer"; tabId?: string },
  ) => Promise<void>;
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
}

export function useQueuedDispatch({
  tabs,
  sendChat,
  updateTab,
}: UseQueuedDispatchParams): void {
  const dispatchingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.kind !== "agent") continue;
      if (tab.waiting) continue;
      // Defensive: persisted tabs created before this feature don't have
      // queuedMessages on disk. The sessionUiSnapshot loader now seeds
      // [], but a tab created by the bridge / a hand-crafted state
      // patch might still arrive without it.
      const queue = tab.queuedMessages ?? [];
      if (queue.length === 0) continue;
      if (tab.queuedSteeringId) continue;
      if (dispatchingRef.current.has(tab.id)) continue;

      const head = queue[0];
      dispatchingRef.current.add(tab.id);

      // Pop the head only. `sendChat`'s normal-dispatch path is
      // responsible for re-flipping `waiting` to true (and the user
      // message into history). The pop + sendChat's three setState
      // calls batch into a single render commit, so the composer
      // doesn't flash Send between turns despite waiting briefly
      // reading as false in this body. Pre-flipping waiting here
      // breaks the drain: sendChat reads stateRef synchronously,
      // sees waiting=true, and routes the popped message right back
      // into the queue with a new id.
      updateTab(tab.id, (t) => {
        const current = t.queuedMessages ?? [];
        if (current.length === 0) return t;
        const next = current.slice(1);
        return {
          ...t,
          queuedMessages: next,
          queueCount: next.length,
        };
      });

      sendChat(head.content, { mode: "normal", tabId: tab.id }).finally(() => {
        dispatchingRef.current.delete(tab.id);
      });
    }
  }, [tabs, sendChat, updateTab]);
}
