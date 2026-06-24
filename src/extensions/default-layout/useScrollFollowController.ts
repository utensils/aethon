import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { VirtuosoHandle, ListRange } from "react-virtuoso";
import type { ChatMessage } from "../../types/a2ui";
import { isAtBottom as metricsAtBottom } from "../../utils/stickyScrollController";
import {
  searchableTextForRow,
  type TranscriptRow,
} from "../../utils/transcriptRows";
import type { ResolvedVisibility } from "../../utils/visibilityResolver";
import {
  createScrollPinScheduler,
  type ScrollPinScheduler,
} from "./scrollPinScheduler";
import {
  appendedUserTurnResumesFollow,
  visibilityReanchorIndex,
} from "./scrollReanchorPolicies";
import { createScrollIntentTracker } from "./scrollIntentTracker";
import {
  defaultTabScrollAnchorStore,
  dropStaleRestoreAnchor,
  initialIndexForRestoreAnchor,
  restoreAnchorForTab,
  updateAnchorFromRange,
  updateAnchorFromUserScroll,
  type TabScrollAnchorStore,
} from "./scrollFollowStore";

// Distance (px) from the bottom still treated as "at the bottom" — used by the
// scroll handler's metricsAtBottom check (follow on/off) and the canScroll
// overflow check that gates the scroll-to-bottom pill.
const DEFAULT_AT_BOTTOM_THRESHOLD = 60;

interface UseScrollFollowControllerArgs {
  messages: ChatMessage[];
  rows: TranscriptRow[];
  tabId?: string;
  scrollToMatch?: string;
  visibility: ResolvedVisibility;
  terminalOpen: boolean;
  layoutRows: unknown;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  anchorStore?: TabScrollAnchorStore;
}

export interface ScrollFollowController {
  following: boolean;
  canScroll: boolean;
  flashIndex: number | null;
  initialTopMostItemIndex: { index: number; align: "start" | "end" };
  setFollowing: (next: boolean) => void;
  scrollToBottom: (settleMs?: number) => void;
  handleRangeChanged: (range: ListRange) => void;
  handleScrollerRef: (ref: HTMLElement | Window | null) => void;
  handleTotalListHeightChanged: () => void;
  scrollerElement: HTMLElement | null;
}

export function resetScrollFollowCacheForTests(): void {
  defaultTabScrollAnchorStore.clear();
}

export function getScrollFollowCacheAnchorForTests(
  tabId: string,
): string | undefined {
  return defaultTabScrollAnchorStore.get(tabId);
}

/** React orchestration layer for chat transcript follow/pin behavior.
 *  Ownership is split across explicit collaborators:
 *  - scrollFollowStore owns per-tab restore anchors,
 *  - scrollIntentTracker owns user-vs-programmatic scroll detection,
 *  - scrollPinScheduler owns imperative bottom pin coalescing/cleanup,
 *  - scrollReanchorPolicies owns visibility/new-turn re-anchor decisions.
 *  Virtuoso's `followOutput` remains disabled; this hook wires the pieces to
 *  React lifecycle, refs, and transcript state. */
export function useScrollFollowController({
  messages,
  rows,
  tabId,
  scrollToMatch,
  visibility,
  terminalOpen,
  layoutRows,
  virtuosoRef,
  anchorStore = defaultTabScrollAnchorStore,
}: UseScrollFollowControllerArgs): ScrollFollowController {
  // `following` drives the pill (render); `followingRef` is the synchronous
  // source of truth the re-pin + filter effects read. They move together via
  // setFollowing(). This flag is the single owner of stick-to-bottom intent.
  // A cached snapshot exists only for a tab left scrolled-up, so seed
  // follow=false when restoring one — otherwise default to following.
  const initialFollowing = !(tabId !== undefined && anchorStore.has(tabId));
  const [following, setFollowingState] = useState(initialFollowing);
  const followingRef = useRef(initialFollowing);
  const [canScroll, setCanScroll] = useState(false);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const intentTrackerRef = useRef<ReturnType<
    typeof createScrollIntentTracker
  > | null>(null);
  const pinSchedulerRef = useRef<ScrollPinScheduler | null>(null);
  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const prevScrollToMatch = useRef<string | undefined>(undefined);
  const prevLastMessageId = useRef(messages[messages.length - 1]?.id);
  // Topmost visible row index, fed by Virtuoso's rangeChanged — used to recover
  // the reading anchor when a filter toggle rebuilds the virtual row list.
  const lastRangeRef = useRef<ListRange | null>(null);
  // Always-current rows for synchronous reads inside event handlers (scroll /
  // rangeChanged), which fire outside the render that produced `rows`. Synced
  // in a layout effect (refs must not be written during render); event handlers
  // run after commit, so the ref is current by the time they fire.
  const rowsRef = useRef(rows);
  useLayoutEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const prevRowsRef = useRef<TranscriptRow[]>(rows);
  const prevVisRef = useRef({
    toolCalls: visibility.toolCalls,
    thinking: visibility.thinking,
  });

  const setFollowing = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowingState(next);
  }, []);

  const updateCanScroll = useCallback(() => {
    const el = scrollerElRef.current;
    setCanScroll(
      Boolean(
        el && el.scrollHeight - el.clientHeight > DEFAULT_AT_BOTTOM_THRESHOLD,
      ),
    );
  }, []);

  useLayoutEffect(() => {
    const scheduler = createScrollPinScheduler({
      getScroller: () => scrollerElRef.current,
      getRowsLength: () => rowsRef.current.length,
      getVirtuoso: () => virtuosoRef.current,
      isFollowing: () => followingRef.current,
      updateCanScroll,
    });
    pinSchedulerRef.current = scheduler;
    return () => {
      scheduler.cancel();
      if (pinSchedulerRef.current === scheduler) pinSchedulerRef.current = null;
    };
  }, [updateCanScroll, virtuosoRef]);

  const scrollToBottom = useCallback((settleMs = 150) => {
    pinSchedulerRef.current?.schedulePin(settleMs);
  }, []);

  // Sole follow on/off path. Only a gesture-flagged scroll recomputes follow
  // from the live position; un-flagged scroll events (our own re-pins) are
  // ignored. Because content reflow/growth fires no scroll event, follow can
  // never be flipped off by streaming — only by a real user scroll-away.
  const handleScroll = useCallback(() => {
    updateCanScroll();
    if (!intentTrackerRef.current?.consumeUserIntent()) return;
    const el = scrollerElRef.current;
    if (!el) return;
    const atBottom = metricsAtBottom(
      {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      },
      DEFAULT_AT_BOTTOM_THRESHOLD,
    );
    setFollowing(atBottom);
    updateAnchorFromUserScroll({
      atBottom,
      range: lastRangeRef.current,
      rows: rowsRef.current,
      store: anchorStore,
      tabId,
    });
  }, [anchorStore, setFollowing, tabId, updateCanScroll]);

  useLayoutEffect(() => {
    const tracker = createScrollIntentTracker(handleScroll);
    intentTrackerRef.current = tracker;
    const el = scrollerElRef.current;
    if (el) tracker.attach(el);
    return () => {
      tracker.detach();
      if (intentTrackerRef.current === tracker) intentTrackerRef.current = null;
    };
  }, [handleScroll]);

  // Track the topmost visible row and, while scrolled-up, keep the per-tab
  // restore anchor current as the user scrolls (so switching away restores the
  // exact message they were reading, even after new messages arrived).
  const handleRangeChanged = useCallback(
    (range: ListRange) => {
      lastRangeRef.current = range;
      updateAnchorFromRange({
        following: followingRef.current,
        range,
        rows: rowsRef.current,
        store: anchorStore,
        tabId,
      });
    },
    [anchorStore, tabId],
  );

  const handleScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      intentTrackerRef.current?.detach();
      const el =
        typeof HTMLElement !== "undefined" && ref instanceof HTMLElement
          ? ref
          : null;
      scrollerElRef.current = el;
      setScrollerEl(el);
      if (el) intentTrackerRef.current?.attach(el);
      updateCanScroll();
    },
    [updateCanScroll],
  );

  // Content grew/shrank (append, streamed token, tool/thinking expand, late
  // reflow, footer). While following, re-pin to the bottom instantly. This is
  // the SOLE re-pin source — Virtuoso's own followOutput is disabled — so no
  // second scroller races it. Reflow that fires no scroll event is caught here,
  // which is what keeps a fresh mount (async highlight/markdown reflow) pinned.
  const handleTotalListHeightChanged = useCallback(() => {
    updateCanScroll();
    if (followingRef.current) scrollToBottom();
  }, [scrollToBottom, updateCanScroll]);

  // Detach the scroll listeners when the keyed instance unmounts (tab switch).
  // The per-tab snapshot is maintained live in handleScroll (gated to genuine
  // user scrolls), so there is deliberately NO getState-on-unmount here — that
  // would capture a transient pre-restore scrollTop under React StrictMode's
  // dev double-mount and clobber the cached position.
  useLayoutEffect(() => () => intentTrackerRef.current?.detach(), []);

  // Terminal open/resize changes the chat viewport height without changing the
  // list height, so Virtuoso's totalListHeightChanged callback never fires. If
  // the user is following the transcript, keep the bottom pinned through that
  // viewport resize; if they intentionally scrolled up, preserve their anchor.
  useLayoutEffect(() => {
    if (!scrollerEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateCanScroll();
      if (followingRef.current) scrollToBottom(900);
    });
    observer.observe(scrollerEl);
    return () => observer.disconnect();
  }, [scrollerEl, scrollToBottom, updateCanScroll]);

  // The workstation grid row string is the source of truth for terminal
  // open/close height. ResizeObserver is useful but not sufficient on WebKit:
  // repeated 0px ↔ Npx terminal toggles can leave Virtuoso visually unpinned
  // while our follow flag is still true. Treat the state transition itself as
  // a follow-preserving resize signal.
  useLayoutEffect(() => {
    if (followingRef.current) scrollToBottom(900);
  }, [layoutRows, scrollToBottom, scrollerEl, terminalOpen]);

  // Jump to the newest message matching the search needle and flash it. Virtuoso
  // mounts the target row even when it's far offscreen, so no DOM walk is needed.
  useEffect(() => {
    if (!scrollToMatch || scrollToMatch === prevScrollToMatch.current) return;
    const needle = scrollToMatch.toLowerCase();
    // Search runs over virtual rows so the scroll index matches Virtuoso's
    // flattened data. Collapsed summaries include the text/tool metadata they
    // contain, so a folded historical turn can still be found and flashed.
    const idx = rows.findIndex((row) =>
      searchableTextForRow(row).toLowerCase().includes(needle),
    );
    if (idx < 0) return;
    prevScrollToMatch.current = scrollToMatch;
    virtuosoRef.current?.scrollToIndex({ index: idx, align: "center" });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- transient flash driven by an external search action (the same effect also imperatively scrolls); not derivable during render
    setFlashIndex(idx);
    const timer = window.setTimeout(() => setFlashIndex(null), 1200);
    return () => window.clearTimeout(timer);
  }, [rows, scrollToMatch, virtuosoRef]);

  // Per-tab restore: map the saved top-of-viewport message id to its current row
  // index. When present, open there (aligned to the top); otherwise open pinned
  // to the bottom. These are mutually exclusive — a bottom initial index would
  // otherwise win over any restore.
  const restoreAnchorId = restoreAnchorForTab(anchorStore, tabId);
  const { restoreIndex, initialTopMostItemIndex } = initialIndexForRestoreAnchor(
    { rows, restoreAnchorId },
  );

  // A cached restore anchor that no longer exists (chat cleared via Cmd+K, or a
  // session rollback truncated it away) is stale: restoreIndex is -1 so the list
  // opens at the bottom, but `following` was seeded false — which would leave the
  // pill showing at the bottom with content-growth re-pins disabled. Drop the
  // stale entry and resume following at the live bottom.
  useLayoutEffect(() => {
    const dropped = dropStaleRestoreAnchor({
      restoreAnchorId,
      restoreIndex,
      store: anchorStore,
      tabId,
    });
    if (!dropped || followingRef.current) return;
    setFollowing(true);
    scrollToBottom();
  }, [anchorStore, restoreAnchorId, restoreIndex, scrollToBottom, setFollowing, tabId]);

  // A new user turn is an explicit request to continue the conversation, so the
  // transcript should resume following even if the user had been reading above
  // the bottom before they sent it. Streaming output still respects manual
  // scroll-away because only a newly appended user message reaches this branch.
  // Batched updates can append the user message and the first agent/tool row in
  // one render, so scan everything appended after the previous tail instead of
  // checking only the latest row.
  useLayoutEffect(() => {
    const previousId = prevLastMessageId.current;
    prevLastMessageId.current = messages[messages.length - 1]?.id;
    if (!appendedUserTurnResumesFollow({ messages, previousTailId: previousId })) {
      return;
    }
    if (tabId !== undefined) anchorStore.delete(tabId);
    if (!followingRef.current) setFollowing(true);
    scrollToBottom(900);
  }, [anchorStore, messages, scrollToBottom, setFollowing, tabId]);

  // Toggling a transcript filter (tool-call grouping / thinking visibility)
  // rebuilds `rows` with a different length + identity. Re-anchor exactly once
  // per toggle (NOT per streamed token — visibility is the guard) so the view
  // never jumps: a following user stays pinned to the new bottom; a scrolled-up
  // user keeps the message they were reading in place.
  useLayoutEffect(() => {
    const prevVis = prevVisRef.current;
    const prevRows = prevRowsRef.current;
    const visChanged =
      prevVis.toolCalls !== visibility.toolCalls ||
      prevVis.thinking !== visibility.thinking;
    prevVisRef.current = {
      toolCalls: visibility.toolCalls,
      thinking: visibility.thinking,
    };
    prevRowsRef.current = rows;
    if (!visChanged) return;

    if (followingRef.current) {
      scrollToBottom();
      return;
    }

    // Map the topmost visible message id from the OLD rows to its index in
    // the NEW rows and pin it to the top (preserves the reading position).
    const newIndex = visibilityReanchorIndex({
      messages,
      newRows: rows,
      oldRows: prevRows,
      startIndex: lastRangeRef.current?.startIndex ?? 0,
    });
    if (newIndex >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: newIndex, align: "start" });
    }
  }, [rows, messages, scrollToBottom, visibility, virtuosoRef]);

  return {
    following,
    canScroll,
    flashIndex,
    initialTopMostItemIndex,
    setFollowing,
    scrollToBottom,
    handleRangeChanged,
    handleScrollerRef,
    handleTotalListHeightChanged,
    scrollerElement: scrollerEl,
  };
}
