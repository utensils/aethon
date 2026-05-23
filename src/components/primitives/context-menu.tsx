/**
 * ContextMenu — shared primitive for right-click and menu-button menus.
 *
 * Portal-mounted, viewport-clamped, keyboard-navigable. Used by the
 * sidebar (project / session / extension menus), file tree (file ops),
 * and any other surface that needs a contextual menu.
 *
 * Not part of the A2UI SkillRegistry — chrome composites compose it
 * directly. The shape is deliberately small (a flat items array) so
 * callers don't need a builder API.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampFixedOverlay } from "../../utils/zoom-probe";

export interface ContextMenuOption {
  id: string;
  label: string;
  /** Right-aligned hint (keyboard shortcut, status, etc.). */
  hint?: string;
  /** Visual treatment for destructive actions; doesn't change behavior. */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}
export interface ContextMenuSeparator {
  type: "separator";
}
export interface ContextMenuHeader {
  type: "header";
  label: string;
}
export interface ContextMenuNote {
  type: "note";
  label: string;
}
export type ContextMenuItem =
  | ContextMenuOption
  | ContextMenuSeparator
  | ContextMenuHeader
  | ContextMenuNote;

export interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Extra className for layout-specific width / wide-label tweaks. */
  className?: string;
  ariaLabel?: string;
  estimatedWidth?: number;
  estimatedHeight?: number;
}

function isOption(item: ContextMenuItem): item is ContextMenuOption {
  return !("type" in item);
}

export function ContextMenu({
  open,
  x,
  y,
  items,
  onClose,
  className,
  ariaLabel = "Context menu",
  estimatedWidth = 220,
  estimatedHeight = 160,
}: ContextMenuProps) {
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const opener = useRef<Element | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // Indices in `items` that map to focusable buttons (skips separator /
  // header / note + disabled).
  const focusableIndices = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (isOption(it) && !it.disabled) out.push(i);
    }
    return out;
  }, [items]);

  // Capture the originating focus owner + seed the focused item when the
  // menu opens. setState-in-effect is the right shape here: open is a
  // boolean prop coming from the caller and we want to mirror it onto
  // the internal focus state machine, not derive it on every render.
  //
  // Also move keyboard focus into the menu element itself so the
  // `onKeyDown={onMenuKey}` on the root receives ArrowUp/ArrowDown/Enter.
  // Without this, focus stayed on the originating row, the document-level
  // keyboard listener only caught Esc/Tab, and arrow navigation never
  // reached the menu — the "advertised keyboard navigation" stayed dead.
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seed focus on open
      setFocusedIndex(focusableIndices[0] ?? null);
      // Defer to the next tick so the menu element is in the DOM.
      const t = window.setTimeout(() => {
        menuRef.current?.focus({ preventScroll: true });
      }, 0);
      return () => window.clearTimeout(t);
    } else {
      setFocusedIndex(null);
    }
  }, [open, focusableIndices]);

  // Outside click + Esc/Tab dismiss. Listeners only mount while open.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && menuRef.current && menuRef.current.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        onClose();
      }
    };
    const onResize = () => onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, onClose]);

  // Restore focus to the originating element after the menu closes.
  useEffect(() => {
    if (!open && opener.current instanceof HTMLElement) {
      const node = opener.current;
      // Defer one tick so React finishes unmounting before we move focus.
      const t = window.setTimeout(() => node.focus({ preventScroll: true }), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const focusAt = useCallback(
    (next: number | null) => {
      if (next === null) {
        setFocusedIndex(null);
        return;
      }
      const idx = focusableIndices.includes(next)
        ? next
        : (focusableIndices[0] ?? null);
      setFocusedIndex(idx);
    },
    [focusableIndices],
  );

  const moveFocus = useCallback(
    (delta: 1 | -1) => {
      if (focusableIndices.length === 0) return;
      if (focusedIndex === null) {
        focusAt(
          delta === 1
            ? focusableIndices[0]
            : focusableIndices[focusableIndices.length - 1],
        );
        return;
      }
      const here = focusableIndices.indexOf(focusedIndex);
      const next =
        (here + delta + focusableIndices.length) % focusableIndices.length;
      focusAt(focusableIndices[next]);
    },
    [focusableIndices, focusedIndex, focusAt],
  );

  const onMenuKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveFocus(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveFocus(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        focusAt(focusableIndices[0] ?? null);
      } else if (e.key === "End") {
        e.preventDefault();
        focusAt(focusableIndices[focusableIndices.length - 1] ?? null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (focusedIndex !== null) {
          const it = items[focusedIndex];
          if (isOption(it) && !it.disabled) {
            it.onSelect();
            onClose();
          }
        }
      }
    },
    [items, focusedIndex, focusableIndices, focusAt, moveFocus, onClose],
  );

  if (!open) return null;

  // Re-clamp every render — cheap, and the cursor coords + estimated
  // size hand us reliable bounds. The estimate doesn't have to be
  // exact; clampFixedOverlay just keeps the menu inside the viewport.
  const pos = clampFixedOverlay(x, y, estimatedWidth, estimatedHeight);
  const activeId = focusedIndex !== null ? `${menuId}-i${focusedIndex}` : undefined;

  return createPortal(
    <div
      ref={menuRef}
      id={menuId}
      className={`a2ui-context-menu${className ? ` ${className}` : ""}`}
      role="menu"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-activedescendant={activeId}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onMenuKey}
    >
      {items.map((item, i) => {
        if ("type" in item && item.type === "separator") {
          return <div key={`sep-${i}`} className="a2ui-context-menu-sep" />;
        }
        if ("type" in item && item.type === "header") {
          return (
            <div key={`hdr-${i}`} className="a2ui-context-menu-header">
              {item.label}
            </div>
          );
        }
        if ("type" in item && item.type === "note") {
          return (
            <div key={`note-${i}`} className="a2ui-context-menu-note">
              {item.label}
            </div>
          );
        }
        const isFocused = i === focusedIndex;
        return (
          <button
            key={item.id}
            id={`${menuId}-i${i}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            aria-disabled={item.disabled || undefined}
            className={`a2ui-context-menu-item${item.danger ? " is-danger" : ""}${isFocused ? " is-focused" : ""}`}
            onMouseEnter={() => focusAt(i)}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            <span className="a2ui-context-menu-item-label">{item.label}</span>
            {item.hint ? (
              <span className="a2ui-context-menu-item-hint">{item.hint}</span>
            ) : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

