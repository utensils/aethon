// Command palette — opened via ⌘P (switcher mode) or ⌘⇧P (commands
// mode). Sectioned, fuzzy-matched, keyboard-driven.
//
// State contract (`/palette` slice on the main state object):
//   { open: boolean, mode: "switcher" | "commands",
//     query: string, selectedIndex: number }
//
// Items are derived (not stored) by `selectPaletteItems(state, mode)` so
// the palette always reflects the current tabs / slash commands /
// keybindings without a duplication / sync layer. Each item carries a
// serializable `payload` describing the action; on Enter the palette
// fires onEvent("select", { item }) and App.tsx routes by section. The
// palette itself never imports App's helpers — it's a pure renderer.
//
// Replaceability: registered as the `command-palette` builtin component
// in defaultLayoutSkill so a skill can override it via aethon.registerComponent.
// Pure helpers live in `./palette-items` so vitest can exercise them
// without React.

import { useEffect, useMemo, useRef } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { formatCombo } from "../../utils/keybindings";
import {
  rankItems,
  selectPaletteItems,
  SECTION_LABEL,
  type PaletteItem,
  type PaletteMode,
  type PaletteSection,
} from "./palette-items";

interface PaletteState {
  open: boolean;
  mode: PaletteMode;
  query: string;
  selectedIndex: number;
}

function readPaletteState(state: Record<string, unknown>): PaletteState {
  const p = (state.palette as Partial<PaletteState> | undefined) ?? {};
  return {
    open: !!p.open,
    mode: p.mode === "commands" ? "commands" : "switcher",
    query: typeof p.query === "string" ? p.query : "",
    selectedIndex:
      typeof p.selectedIndex === "number" ? p.selectedIndex : 0,
  };
}

export function CommandPalette({ state, onEvent }: BuiltinComponentProps) {
  const palette = readPaletteState(state);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Re-derive items every render. Cheap (the source state slices are
  // already small) and avoids a stale-snapshot trap if a tab/binding
  // gets registered while the palette is open.
  const allItems = useMemo(
    () => selectPaletteItems(state as never, palette.mode),
    [state, palette.mode],
  );
  const items = useMemo(
    () => rankItems(allItems, palette.query),
    [allItems, palette.query],
  );
  const clamped = items.length > 0
    ? Math.max(0, Math.min(palette.selectedIndex, items.length - 1))
    : 0;

  // Auto-focus the input when opened. Fires once per open transition,
  // not on every state update, by tracking previous open value.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (palette.open && !wasOpenRef.current) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    wasOpenRef.current = palette.open;
  }, [palette.open]);

  // Scroll the active row into view on selection change.
  useEffect(() => {
    if (!palette.open) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${clamped}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [clamped, palette.open]);

  if (!palette.open) return null;

  const close = () => onEvent("close");
  const select = (item: PaletteItem) => onEvent("select", { item });
  const setQuery = (q: string) => onEvent("query", { value: q });
  const setIndex = (idx: number) => onEvent("navigate", { index: idx });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const target = items[clamped];
      if (target) select(target);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(items.length > 0 ? (clamped + 1) % items.length : 0);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(
        items.length > 0
          ? (clamped - 1 + items.length) % items.length
          : 0,
      );
      return;
    }
  };

  // Group display items by section while preserving their ranked order.
  // We don't re-sort within a section — ranking already accounts for the
  // user's section preference (`>`, `@`, `?` prefixes).
  const grouped: { section: PaletteSection; items: PaletteItem[] }[] = [];
  for (const item of items) {
    const last = grouped[grouped.length - 1];
    if (last && last.section === item.section) {
      last.items.push(item);
    } else {
      grouped.push({ section: item.section, items: [item] });
    }
  }

  let runningIndex = 0;
  return (
    <div
      className="ae-palette-overlay"
      onMouseDown={(e) => {
        // Close on backdrop click. Ignore clicks on the panel itself.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="ae-palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="ae-palette-header">
          <span className="ae-palette-icon" aria-hidden="true">⌘</span>
          <input
            ref={inputRef}
            className="ae-palette-input"
            placeholder={
              palette.mode === "switcher"
                ? "Switch to… type > for commands, @ for tabs, ? for keys"
                : "Run command… type @ for tabs, ? for keys"
            }
            value={palette.query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="ae-palette-mode">{palette.mode}</span>
        </div>
        <div className="ae-palette-list" ref={listRef}>
          {items.length === 0 ? (
            <div className="ae-palette-empty">
              No matches{palette.query ? ` for "${palette.query}"` : ""}.
            </div>
          ) : (
            grouped.map(({ section, items: group }) => (
              <div key={section} className="ae-palette-section">
                <div className="ae-palette-section-title">
                  {SECTION_LABEL[section]}
                </div>
                {group.map((item) => {
                  const idx = runningIndex++;
                  const active = idx === clamped;
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={-1}
                      data-row-index={idx}
                      className={
                        active ? "ae-palette-row ae-palette-row-active" : "ae-palette-row"
                      }
                      onMouseEnter={() => setIndex(idx)}
                      onMouseDown={(e) => {
                        // mousedown rather than click so the input's
                        // blur doesn't race the close path.
                        e.preventDefault();
                        select(item);
                      }}
                    >
                      <span className="ae-palette-row-label">{item.label}</span>
                      {item.hint ? (
                        <span className="ae-palette-row-hint">{item.hint}</span>
                      ) : null}
                      {item.shortcut ? (
                        <span className="ae-palette-row-shortcut">
                          {formatCombo(item.shortcut)}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="ae-palette-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>Esc</kbd> close</span>
          <span className="ae-palette-footer-tip">
            <kbd>&gt;</kbd> commands · <kbd>@</kbd> tabs · <kbd>?</kbd> keys
          </span>
        </div>
      </div>
    </div>
  );
}
