import {
  useCallback,
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

  const startComposerResize = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      composerResizeRef.current = {
        startY: e.clientY,
        startH: composerHeight,
      };
      document.body.classList.add("ae-resizing-composer");
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
      const onUp = () => {
        composerResizeRef.current = null;
        document.body.classList.remove("ae-resizing-composer");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [composerHeight],
  );

  return { composerHeight, startComposerResize };
}
