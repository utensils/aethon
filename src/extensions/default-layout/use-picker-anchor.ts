import { useEffect, useState, type RefObject } from "react";
import { readUiScale } from "./layout";

export interface PickerAnchor {
  left: number;
  bottom: number;
  width: number;
}

/**
 * Fixed-position anchor for composer popovers (slash picker, @file
 * picker). Portal-rendered menus must escape the layout cell's
 * `overflow: hidden`, so they position against the composer's viewport
 * rect instead of the DOM tree.
 *
 * `activeKey` doubles as the open flag and the reposition trigger: pass
 * the live match object so the anchor re-measures on every keystroke
 * (the composer can grow/shrink while typing), or null/undefined to
 * close.
 */
export function usePickerAnchor(
  anchorRef: RefObject<HTMLDivElement | null>,
  activeKey: unknown,
): PickerAnchor | null {
  const [menuAnchor, setMenuAnchor] = useState<PickerAnchor | null>(null);

  useEffect(() => {
    if (!activeKey || !anchorRef.current) {
      setMenuAnchor(null);
      return;
    }
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) {
        setMenuAnchor(null);
        return;
      }
      const r = anchor.getBoundingClientRect();
      const hasMeasuredLayout =
        r.width !== 0 ||
        r.height !== 0 ||
        r.top !== 0 ||
        r.right !== 0 ||
        r.bottom !== 0 ||
        r.left !== 0;
      if (
        hasMeasuredLayout &&
        (r.width <= 0 ||
          r.height <= 0 ||
          r.bottom <= 0 ||
          r.top >= window.innerHeight ||
          r.right <= 0 ||
          r.left >= window.innerWidth)
      ) {
        setMenuAnchor(null);
        return;
      }
      const scale = readUiScale();
      const viewportWidth = window.innerWidth / scale;
      const viewportHeight = window.innerHeight / scale;
      const left = Math.max(
        8,
        Math.min(r.left / scale + 16, viewportWidth - 128),
      );
      const availableWidth = Math.max(0, viewportWidth - left - 8);
      const preferredWidth = Math.max(160, r.width / scale - 32);
      setMenuAnchor({
        left,
        bottom: Math.max(8, viewportHeight - r.top / scale + 4),
        width: Math.min(preferredWidth, availableWidth || preferredWidth),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, activeKey]);

  return menuAnchor;
}
