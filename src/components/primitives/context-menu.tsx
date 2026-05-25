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
  keepOpenOnSelect?: boolean;
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
export interface ContextMenuInput {
  type: "input";
  id: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
}
export type ContextMenuItem =
  | ContextMenuOption
  | ContextMenuSeparator
  | ContextMenuHeader
  | ContextMenuNote
  | ContextMenuInput;

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

function isInputItem(item: ContextMenuItem): item is ContextMenuInput {
  return "type" in item && item.type === "input";
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
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
  const wasOpenRef = useRef(false);
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
  const firstFocusableIndex = focusableIndices[0] ?? null;
  const hasInputItem = useMemo(() => items.some(isInputItem), [items]);

  // Capture the originating focus owner + seed the focused item when the
  // menu opens. setState-in-effect is the right shape here: open is a
  // boolean prop coming from the caller and we want to mirror it onto
  // the internal focus state machine, not derive it on every render.
  //
  // Also move keyboard focus into the menu (or its inline input) so
  // keyboard interactions do not stay on the originating row. Without
  // this, the document-level keyboard listener only caught Esc/Tab, and
  // arrow navigation never reached option-only menus — the "advertised
  // keyboard navigation" stayed dead.
  //
  // Run only on closed -> open transitions. Parent chrome (notably the
  // tab strip while an agent is streaming) can re-render the menu many
  // times with fresh `items` arrays; re-focusing on every such render
  // steals focus back from inline rename inputs and makes typing unusable.
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear mirrored focus state on close
      setFocusedIndex(null);
      return;
    }
    if (wasOpenRef.current) return;

    wasOpenRef.current = true;
    opener.current = document.activeElement;
    setFocusedIndex(firstFocusableIndex);
    const firstInput = hasInputItem
      ? menuRef.current?.querySelector<HTMLElement>("input, textarea, select")
      : null;
    (firstInput ?? menuRef.current)?.focus({ preventScroll: true });
  }, [open, firstFocusableIndex, hasInputItem]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp virtual focus after item list changes without moving DOM focus
    setFocusedIndex((current) => {
      if (current === null || focusableIndices.includes(current)) return current;
      return firstFocusableIndex;
    });
  }, [open, focusableIndices, firstFocusableIndex]);

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
      if (isTextEntryTarget(e.target)) return;
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
          if (it && isOption(it) && !it.disabled) {
            it.onSelect();
            if (!it.keepOpenOnSelect) onClose();
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
        if ("type" in item && item.type === "input") {
          return (
            <form
              key={item.id}
              className="a2ui-context-menu-input"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                item.onSubmit(String(data.get("value") ?? ""));
                onClose();
              }}
            >
              <label>
                <span>{item.label}</span>
                <input
                  name="value"
                  defaultValue={item.defaultValue}
                  placeholder={item.placeholder}
                  autoFocus
                />
              </label>
              <button type="submit">{item.submitLabel ?? "Save"}</button>
            </form>
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
              if (!item.keepOpenOnSelect) onClose();
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
