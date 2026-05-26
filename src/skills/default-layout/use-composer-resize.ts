import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

const COMPOSER_MIN_HEIGHT = 46;
const COMPOSER_MAX_HEIGHT = 360;

export function useComposerResize(initialHeight = 70) {
  const [composerHeight, setComposerHeight] = useState<number>(initialHeight);
  const composerResizeRef = useRef<{ startY: number; startH: number } | null>(
    null,
  );
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const stopComposerResize = useCallback(() => {
    dragCleanupRef.current?.();
  }, []);

  useEffect(() => stopComposerResize, [stopComposerResize]);

  const startComposerResize = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      stopComposerResize();
      const controller = new AbortController();
      composerResizeRef.current = {
        startY: e.clientY,
        startH: composerHeight,
      };
      document.body.classList.add("ae-resizing-composer");
      dragCleanupRef.current = () => {
        controller.abort();
        composerResizeRef.current = null;
        document.body.classList.remove("ae-resizing-composer");
        dragCleanupRef.current = null;
      };
      const onMove = (ev: MouseEvent) => {
        const ref = composerResizeRef.current;
        if (!ref) return;
        const dy = ref.startY - ev.clientY;
        const next = Math.max(
          COMPOSER_MIN_HEIGHT,
          Math.min(COMPOSER_MAX_HEIGHT, Math.round(ref.startH + dy)),
        );
        setComposerHeight(next);
      };
      document.addEventListener("mousemove", onMove, {
        signal: controller.signal,
      });
      document.addEventListener("mouseup", stopComposerResize, {
        signal: controller.signal,
      });
    },
    [composerHeight, stopComposerResize],
  );

  return { composerHeight, startComposerResize };
}
