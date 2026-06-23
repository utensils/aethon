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
  anchorMessageIdForRow,
  findRowIndexForMessageId,
  searchableTextForRow,
  type TranscriptRow,
} from "../../utils/transcriptRows";
import type { ResolvedVisibility } from "../../utils/visibilityResolver";

// Distance (px) from the bottom still treated as "at the bottom" — used by the
// scroll handler's metricsAtBottom check (follow on/off) and the canScroll
// overflow check that gates the scroll-to-bottom pill.
const DEFAULT_AT_BOTTOM_THRESHOLD = 60;

// tabId → the message id at the top of the viewport when the tab was left
// scrolled-up (absent when it was left following at the bottom). The message
// list is keyed by tab id (see ChatHistory / MainCanvas), so each tab mounts its
// own Virtuoso instance; on the next mount we map this id back to its current
// row index and open there via initialTopMostItemIndex. Keyed by message id, not
// pixels, so it survives new messages arriving while the tab is backgrounded and
// avoids react-virtuoso's fragile getState/restoreStateFrom scrollTop timing.
// Module-level so it survives the keyed remount.
const tabScrollCache = new Map<string, string>();

// Follow state must flip only on a genuine USER scroll, never on the
// programmatic re-pins we issue while following (those would otherwise be read
// back as "the user scrolled"). Content reflow/growth does NOT fire a scroll
// event, so the only scroll events to disambiguate are user gestures vs our own
// scrollTo. We mark a user gesture (wheel / touch / scroll-key) and let the
// resulting scroll event recompute follow; un-gestured scroll events (our
// re-pins) are ignored. This is what makes a scroll-away win the race against an
// in-flight streaming re-pin.
const USER_SCROLL_INTENT_EVENTS = [
  "wheel",
  "touchstart",
  "touchmove",
  "pointerdown",
  "keydown",
] as const;
const SCROLL_INTENT_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

function isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest(
      "button,a,input,textarea,select,[role='button'],[role='link'],[role='textbox'],[tabindex]:not([tabindex='-1'])",
    ),
  );
}

function isUserScrollIntentEvent(event: Event): boolean {
  if (!(event instanceof KeyboardEvent)) return true;
  if (!SCROLL_INTENT_KEYS.has(event.key)) return false;
  if (isInteractiveKeyboardTarget(event.target)) return false;
  return true;
}

function addUserScrollIntentListeners(
  el: HTMLElement,
  listener: EventListener,
): void {
  for (const eventName of USER_SCROLL_INTENT_EVENTS) {
    el.addEventListener(eventName, listener, { passive: true });
  }
}

function removeUserScrollIntentListeners(
  el: HTMLElement,
  listener: EventListener,
): void {
  for (const eventName of USER_SCROLL_INTENT_EVENTS) {
    el.removeEventListener(eventName, listener);
  }
}

interface UseScrollFollowControllerArgs {
  messages: ChatMessage[];
  rows: TranscriptRow[];
  tabId?: string;
  scrollToMatch?: string;
  visibility: ResolvedVisibility;
  terminalOpen: boolean;
  layoutRows: unknown;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
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
  tabScrollCache.clear();
}

export function getScrollFollowCacheAnchorForTests(
  tabId: string,
): string | undefined {
  return tabScrollCache.get(tabId);
}

/** Owns chat transcript follow/pin behavior. Virtuoso's `followOutput` remains
 *  disabled; this hook is the single source of truth for user scroll intent,
 *  per-tab restore anchors, content-growth pinning, terminal resize repins,
 *  search jumps, and visibility-toggle re-anchoring. */
export function useScrollFollowController({
  messages,
  rows,
  tabId,
  scrollToMatch,
  visibility,
  terminalOpen,
  layoutRows,
  virtuosoRef,
}: UseScrollFollowControllerArgs): ScrollFollowController {
  // `following` drives the pill (render); `followingRef` is the synchronous
  // source of truth the re-pin + filter effects read. They move together via
  // setFollowing(). This flag is the single owner of stick-to-bottom intent.
  // A cached snapshot exists only for a tab left scrolled-up (see handleScroll),
  // so seed follow=false when restoring one — otherwise default to following.
  const initialFollowing = !(tabId !== undefined && tabScrollCache.has(tabId));
  const [following, setFollowingState] = useState(initialFollowing);
  const followingRef = useRef(initialFollowing);
  const [canScroll, setCanScroll] = useState(false);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // Set by a user gesture (wheel/touch/scroll-key); the next scroll event reads
  // and clears it. Distinguishes a real scroll-away from our own re-pins.
  const userScrollRef = useRef(false);
  const pinRafRef = useRef<number | null>(null);
  const pinDeadlineRef = useRef(0);
  const pinTimeoutsRef = useRef<number[]>([]);
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

  const scrollToBottom = useCallback(
    (settleMs = 150) => {
      const startedAt =
        typeof performance === "undefined" ? Date.now() : performance.now();
      const now = () =>
        typeof performance === "undefined" ? Date.now() : performance.now();
      pinDeadlineRef.current = Math.max(
        pinDeadlineRef.current,
        startedAt + settleMs,
      );

      // Scroll to the true bottom of the scroller — this includes the footer's
      // live subtree / typing indicator, which sit below the last data row.
      const pinDomScroller = () => {
        const el = scrollerElRef.current;
        const bottomGap = el
          ? el.scrollHeight - el.clientHeight - el.scrollTop
          : Number.POSITIVE_INFINITY;
        if (bottomGap <= 2) {
          updateCanScroll();
          return;
        }
        const lastIndex = Math.max(0, rowsRef.current.length - 1);
        virtuosoRef.current?.scrollToIndex({ index: lastIndex, align: "end" });
        virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
        if (el) el.scrollTop = el.scrollHeight;
        updateCanScroll();
      };
      const pinIfStillFollowing = () => {
        if (followingRef.current) pinDomScroller();
      };
      pinDomScroller();
      const frame = () => {
        pinRafRef.current = null;
        if (!followingRef.current) return;
        pinDomScroller();
        if (now() < pinDeadlineRef.current) {
          pinRafRef.current = window.requestAnimationFrame(frame);
        }
      };
      if (pinRafRef.current === null) {
        pinRafRef.current = window.requestAnimationFrame(frame);
      }
      for (const timeoutId of pinTimeoutsRef.current) {
        window.clearTimeout(timeoutId);
      }
      pinTimeoutsRef.current = [];
      for (const delay of [50, 150, 300, 600, 900]) {
        if (delay <= settleMs) {
          pinTimeoutsRef.current.push(
            window.setTimeout(pinIfStillFollowing, delay),
          );
        }
      }
    },
    [updateCanScroll, virtuosoRef],
  );

  useEffect(() => {
    return () => {
      if (pinRafRef.current !== null) {
        window.cancelAnimationFrame(pinRafRef.current);
        pinRafRef.current = null;
      }
      for (const timeoutId of pinTimeoutsRef.current) {
        window.clearTimeout(timeoutId);
      }
      pinTimeoutsRef.current = [];
    };
  }, []);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (isUserScrollIntentEvent(event)) userScrollRef.current = true;
  }, []);

  // Sole follow on/off path. Only a gesture-flagged scroll recomputes follow
  // from the live position; un-flagged scroll events (our own re-pins) are
  // ignored. Because content reflow/growth fires no scroll event, follow can
  // never be flipped off by streaming — only by a real user scroll-away.
  const handleScroll = useCallback(() => {
    updateCanScroll();
    if (!userScrollRef.current) return;
    userScrollRef.current = false;
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
    // Per-tab scroll restore: remember the top-of-viewport message id while
    // scrolled-up; clear it when the user returns to the bottom (so the tab
    // reopens following at the live bottom). ONLY user-gestured scrolls touch
    // the cache — programmatic re-pins and the restore itself are un-gestured,
    // so a transient mount-time position (e.g. React StrictMode's dev remount)
    // can never clobber it. rangeChanged keeps this fresh as the user scrolls.
    if (tabId !== undefined) {
      if (atBottom) {
        tabScrollCache.delete(tabId);
      } else {
        const anchorId = anchorMessageIdForRow(
          rowsRef.current[lastRangeRef.current?.startIndex ?? 0],
        );
        if (anchorId) tabScrollCache.set(tabId, anchorId);
      }
    }
  }, [setFollowing, tabId, updateCanScroll]);

  // Track the topmost visible row and, while scrolled-up, keep the per-tab
  // restore anchor current as the user scrolls (so switching away restores the
  // exact message they were reading, even after new messages arrived).
  const handleRangeChanged = useCallback(
    (range: ListRange) => {
      lastRangeRef.current = range;
      if (tabId !== undefined && !followingRef.current) {
        const anchorId = anchorMessageIdForRow(rowsRef.current[range.startIndex]);
        if (anchorId) tabScrollCache.set(tabId, anchorId);
      }
    },
    [tabId],
  );

  const handleScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      const prev = scrollerElRef.current;
      if (prev) {
        prev.removeEventListener("scroll", handleScroll);
        removeUserScrollIntentListeners(prev, markUserScrollIntent);
      }
      const el =
        typeof HTMLElement !== "undefined" && ref instanceof HTMLElement
          ? ref
          : null;
      scrollerElRef.current = el;
      setScrollerEl(el);
      if (el) {
        el.addEventListener("scroll", handleScroll, { passive: true });
        addUserScrollIntentListeners(el, markUserScrollIntent);
      }
      updateCanScroll();
    },
    [handleScroll, markUserScrollIntent, updateCanScroll],
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
  useLayoutEffect(() => {
    return () => {
      const el = scrollerElRef.current;
      if (el) {
        el.removeEventListener("scroll", handleScroll);
        removeUserScrollIntentListeners(el, markUserScrollIntent);
      }
    };
  }, [handleScroll, markUserScrollIntent]);

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
  const restoreAnchorId =
    tabId !== undefined ? tabScrollCache.get(tabId) : undefined;
  const restoreIndex = restoreAnchorId
    ? findRowIndexForMessageId(rows, restoreAnchorId)
    : -1;
  const initialTopMostItemIndex =
    restoreIndex >= 0
      ? { index: restoreIndex, align: "start" as const }
      : { index: Math.max(0, rows.length - 1), align: "end" as const };

  // A cached restore anchor that no longer exists (chat cleared via Cmd+K, or a
  // session rollback truncated it away) is stale: restoreIndex is -1 so the list
  // opens at the bottom, but `following` was seeded false — which would leave the
  // pill showing at the bottom with content-growth re-pins disabled. Drop the
  // stale entry and resume following at the live bottom.
  useLayoutEffect(() => {
    if (!restoreAnchorId || restoreIndex >= 0) return;
    if (tabId !== undefined) tabScrollCache.delete(tabId);
    if (!followingRef.current) {
      setFollowing(true);
      scrollToBottom();
    }
  }, [restoreAnchorId, restoreIndex, scrollToBottom, setFollowing, tabId]);

  // A new user turn is an explicit request to continue the conversation, so the
  // transcript should resume following even if the user had been reading above
  // the bottom before they sent it. Streaming output still respects manual
  // scroll-away because only a newly appended user message reaches this branch.
  // Batched updates can append the user message and the first agent/tool row in
  // one render, so scan everything appended after the previous tail instead of
  // checking only the latest row.
  useLayoutEffect(() => {
    const latest = messages[messages.length - 1];
    const previousId = prevLastMessageId.current;
    prevLastMessageId.current = latest?.id;
    if (!latest || latest.id === previousId) return;
    const previousIndex = previousId
      ? messages.findIndex((message) => message.id === previousId)
      : -1;
    const appended =
      previousIndex >= 0 ? messages.slice(previousIndex + 1) : messages;
    if (!appended.some((message) => message.role === "user")) return;
    if (tabId !== undefined) tabScrollCache.delete(tabId);
    if (!followingRef.current) setFollowing(true);
    scrollToBottom(900);
  }, [messages, scrollToBottom, setFollowing, tabId]);

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
    const startIndex = lastRangeRef.current?.startIndex ?? 0;
    const anchorId = anchorMessageIdForRow(prevRows[startIndex]);
    let newIndex = findRowIndexForMessageId(rows, anchorId);
    if (newIndex < 0 && anchorId) {
      // Anchor dropped (e.g. its tool card was hidden): fall back to the nearest
      // preceding message that still survives in the new groups.
      const anchorMsgIdx = messages.findIndex((m) => m.id === anchorId);
      for (let i = anchorMsgIdx - 1; i >= 0; i--) {
        const idx = findRowIndexForMessageId(rows, messages[i].id);
        if (idx >= 0) {
          newIndex = idx;
          break;
        }
      }
    }
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
