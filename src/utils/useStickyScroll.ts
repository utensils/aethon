import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** Distance from the bottom (px) within which we consider the user "at bottom". */
const BOTTOM_THRESHOLD = 60;

/**
 * Sticky-follow scroll for chat windows.
 *
 * When the user is at (or near) the bottom, new content auto-scrolls the
 * container to keep up. Scrolling up breaks auto-follow. Clicking the returned
 * `scrollToBottom` re-enables it. Works with streaming content via
 * `handleContentChanged` — call it whenever content updates asynchronously so
 * the hook can scroll without waiting for a React render cycle.
 *
 * Uses a `programmaticRef` flag to distinguish auto-scrolls from user scrolls
 * so the scroll listener doesn't incorrectly detect our own scrolls as a
 * user-initiated "scroll away". A `requestAnimationFrame` coalescor prevents
 * stacked scroll calls during streaming bursts.
 */
export function useStickyScroll(containerRef: RefObject<HTMLDivElement | null>) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Set before any programmatic scroll so the scroll listener knows to ignore it.
  const programmaticRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const checkAndMaybeScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
    if (atBottom) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
      setIsAtBottom(true);
    } else {
      setIsAtBottom(false);
    }
  }, [containerRef]);

  /** Call when async content changes (streaming tokens, new messages, etc.). */
  const handleContentChanged = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      checkAndMaybeScroll();
    });
  }, [checkAndMaybeScroll]);

  /** Snap to bottom and re-enable auto-follow. */
  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    programmaticRef.current = true;
    el.scrollTop = el.scrollHeight;
    setIsAtBottom(true);
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => {
      // Ignore scrolls we triggered ourselves.
      if (programmaticRef.current) {
        programmaticRef.current = false;
        return;
      }
      const atBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
      setIsAtBottom(atBottom);
    };

    // ResizeObserver: catches panel resize, window resize, font-size changes.
    const ro = new ResizeObserver(handleContentChanged);
    // MutationObserver: catches new message nodes, streaming text, tool-card expansion.
    const mo = new MutationObserver(handleContentChanged);

    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    mo.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      mo.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [containerRef, handleContentChanged]);

  return { isAtBottom, scrollToBottom, handleContentChanged };
}
