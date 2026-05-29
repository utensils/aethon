/**
 * Sidebar resize-drag controller. Wires the drag handle's mousedown to
 * mousemove/mouseup listeners that emit `resize` events with the new
 * pixel width. App listens for those and patches the active layout's
 * grid columns. `resize-end` fires on release so the App can persist.
 */

import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";

// Two-line project rows + the host bar need a little more breathing room
// than the old single-line list, so the floor is nudged up from 180.
const MIN_WIDTH = 200;
const MAX_WIDTH = 560;

export interface UseSidebarResizeDeps {
  onEvent: BuiltinComponentProps["onEvent"];
  resizeFromLeft: boolean;
}

export interface SidebarResizeController {
  asideRef: React.MutableRefObject<HTMLElement | null>;
  onResizeStart: (e: ReactMouseEvent) => void;
}

export function useSidebarResize(
  deps: UseSidebarResizeDeps,
): SidebarResizeController {
  const { onEvent, resizeFromLeft } = deps;
  const asideRef = useRef<HTMLElement | null>(null);

  const onResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    const aside = asideRef.current;
    if (!aside) return;
    const startX = e.clientX;
    const startWidth = aside.getBoundingClientRect().width;
    document.body.classList.add("ae-resizing-sidebar");
    const onMove = (ev: MouseEvent) => {
      const dx = resizeFromLeft ? startX - ev.clientX : ev.clientX - startX;
      const next = Math.max(
        MIN_WIDTH,
        Math.min(MAX_WIDTH, Math.round(startWidth + dx)),
      );
      onEvent("resize", { width: next });
    };
    const onUp = () => {
      document.body.classList.remove("ae-resizing-sidebar");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      onEvent("resize-end");
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return { asideRef, onResizeStart };
}
