import { useEffect, useRef, type MutableRefObject } from "react";
import type { ChatAttachment } from "../types/a2ui";
import type { Tab } from "../types/tab";
import { isAgentTabInFlight } from "../utils/agentBusy";
import type { TabBucket } from "./projectOps/types";

/**
 * Drains client-held queues. Watches every agent tab's in-flight state;
 * when it transitions to idle and the tab still has queued messages, the
 * head pops and ships through `sendChat(..., { mode: "normal" })`.
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
type BucketRecord = Record<string, TabBucket | undefined>;

function appendUniqueTabs(
  result: Tab[],
  seen: Set<string>,
  tabs: readonly Tab[] | undefined,
): void {
  for (const tab of tabs ?? []) {
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    result.push(tab);
  }
}

function bucketValues(source: unknown): TabBucket[] {
  if (!source || typeof source !== "object") return [];
  if (source instanceof Map) return Array.from(source.values());
  if (Array.isArray(source)) return [];
  return Object.values(source as BucketRecord).filter(
    (bucket): bucket is TabBucket =>
      Boolean(bucket) && Array.isArray(bucket?.tabs),
  );
}

export function collectQueuedDispatchTabs(
  visibleTabs: readonly Tab[],
  tabBuckets?: Map<string, TabBucket> | null,
  persistedTabBuckets?: unknown,
): Tab[] {
  const result: Tab[] = [];
  const seen = new Set<string>();

  // Prefer the visible active-bucket record when a tab is present in both
  // places. Stashed bucket snapshots can be older than state.tabs.
  appendUniqueTabs(result, seen, visibleTabs);

  for (const bucket of bucketValues(tabBuckets)) {
    appendUniqueTabs(result, seen, bucket.tabs);
  }

  // Restored persisted buckets are included as a boot-time safety net: the
  // hydration effect that copies them into tabBucketsRef runs after render,
  // while this hook's drain effect is registered in the same commit.
  for (const bucket of bucketValues(persistedTabBuckets)) {
    appendUniqueTabs(result, seen, bucket.tabs);
  }

  return result;
}

export interface UseQueuedDispatchParams {
  tabs: Tab[];
  tabBucketsRef?: MutableRefObject<Map<string, TabBucket>>;
  persistedTabBuckets?: unknown;
  sendChat: (
    text: string,
    options?: {
      mode?: "normal" | "steer";
      tabId?: string;
      attachments?: ChatAttachment[];
      bridgeText?: string;
    },
  ) => Promise<void>;
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
}

export function useQueuedDispatch({
  tabs,
  tabBucketsRef,
  persistedTabBuckets,
  sendChat,
  updateTab,
}: UseQueuedDispatchParams): void {
  const dispatchingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const dispatchTabs = collectQueuedDispatchTabs(
      tabs,
      tabBucketsRef?.current,
      persistedTabBuckets,
    );

    for (const tab of dispatchTabs) {
      if (tab.kind !== "agent") continue;
      if (isAgentTabInFlight(tab)) continue;
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

      sendChat(head.content, {
        mode: "normal",
        tabId: tab.id,
        attachments: head.attachments,
        ...(head.bridgeText ? { bridgeText: head.bridgeText } : {}),
      }).finally(() => {
        dispatchingRef.current.delete(tab.id);
      });
    }
  }, [tabs, tabBucketsRef, persistedTabBuckets, sendChat, updateTab]);
}
