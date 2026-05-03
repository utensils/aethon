import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_BOTTOM_THRESHOLD,
  StickyScrollController,
} from "./stickyScrollController";

/**
 * React adapter over StickyScrollController. The controller (which has
 * its own tests) owns the follow-intent flag; this hook just wires it
 * up to ResizeObserver / MutationObserver and the container's scroll
 * events. The unit tests for the bug-fix logic live next to the
 * controller — see stickyScrollController.test.ts.
 */
export function useStickyScroll(containerRef: RefObject<HTMLDivElement | null>) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const controllerRef = useRef<StickyScrollController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new StickyScrollController(DEFAULT_BOTTOM_THRESHOLD);
  }
  const rafRef = useRef<number | null>(null);

  const handleContentChanged = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = containerRef.current;
      const ctrl = controllerRef.current;
      if (!el || !ctrl) return;
      const decision = ctrl.onContentChanged();
      if (decision.scrollToBottom) el.scrollTop = el.scrollHeight;
    });
  }, [containerRef]);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    const ctrl = controllerRef.current;
    if (!el || !ctrl) return;
    const decision = ctrl.resume();
    if (decision.scrollToBottom) el.scrollTop = el.scrollHeight;
    setIsAtBottom(true);
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    const ctrl = controllerRef.current;
    if (!el || !ctrl) return;

    const onScroll = () => {
      const next = ctrl.onScroll({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      });
      setIsAtBottom(next);
    };

    const ro = new ResizeObserver(handleContentChanged);
    const mo = new MutationObserver(handleContentChanged);

    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    mo.observe(el, { childList: true, subtree: true, characterData: true });

    requestAnimationFrame(() => {
      const elNow = containerRef.current;
      if (elNow && ctrl.follow) elNow.scrollTop = elNow.scrollHeight;
    });

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      mo.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [containerRef, handleContentChanged]);

  return { isAtBottom, scrollToBottom, handleContentChanged };
}
