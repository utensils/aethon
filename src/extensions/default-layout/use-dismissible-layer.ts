import { useEffect, type RefObject } from "react";

type DismissibleLayerOptions = {
  active: boolean;
  onDismiss: () => void;
  insideRefs?: ReadonlyArray<RefObject<HTMLElement | null>>;
  dismissOnPointerOutside?: boolean;
  dismissOnResize?: boolean;
  dismissOnScroll?: boolean;
  capture?: boolean;
};

const NO_INSIDE_REFS: ReadonlyArray<RefObject<HTMLElement | null>> = [];

/** Shared document/window lifecycle for non-modal menus and popovers. */
export function useDismissibleLayer({
  active,
  onDismiss,
  insideRefs = NO_INSIDE_REFS,
  dismissOnPointerOutside = false,
  dismissOnResize = false,
  dismissOnScroll = false,
  capture = false,
}: DismissibleLayerOptions): void {
  useEffect(() => {
    if (!active) return;
    const dismiss = () => onDismiss();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        insideRefs.some((ref) => ref.current?.contains(target))
      ) {
        return;
      }
      dismiss();
    };

    document.addEventListener("keydown", onKeyDown);
    if (dismissOnPointerOutside) {
      document.addEventListener("mousedown", onPointer, capture);
    }
    if (dismissOnResize) window.addEventListener("resize", dismiss);
    // Scroll does not bubble, so capture is required to observe scrolling in
    // nested containers regardless of the pointer-listener capture setting.
    if (dismissOnScroll) document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (dismissOnPointerOutside) {
        document.removeEventListener("mousedown", onPointer, capture);
      }
      if (dismissOnResize) window.removeEventListener("resize", dismiss);
      if (dismissOnScroll) {
        document.removeEventListener("scroll", dismiss, true);
      }
    };
  }, [
    active,
    capture,
    dismissOnPointerOutside,
    dismissOnResize,
    dismissOnScroll,
    insideRefs,
    onDismiss,
  ]);
}
