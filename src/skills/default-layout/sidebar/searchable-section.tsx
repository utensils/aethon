import { useMemo, useState } from "react";
import type {
  SidebarItem,
  SidebarSection,
} from "../../../types/a2ui";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { filterItems, providerOf } from "./filter";
import { ItemRow, type ItemRowProps } from "./item-row";

export interface SidebarSectionExt extends SidebarSection {
  /** When true, render items in mono (used for model ids, layout names). */
  monoItems?: boolean;
  /** When true, surface a small filter input above the items so a long
   *  list (models, themes, layouts) becomes navigable without an
   *  external picker. */
  searchable?: boolean;
  /** When true, group items by their leading id segment (e.g. `claude-`,
   *  `gpt-`, `qwen-`). Auto-renders a small subhead per group. Combines
   *  cleanly with `searchable`: filter first, then group. */
  groupByPrefix?: boolean;
  /** Placeholder for the filter input. */
  searchPlaceholder?: string;
  /** Action buttons rendered as ghost-style rows below the items. Used
   *  by the projects section for "Open project…" — fires the same
   *  select event as a normal item so App.tsx can route by itemId. */
  actions?: { id: string; label: string }[];
}

export interface SearchableSidebarSectionProps {
  section: SidebarSectionExt;
  items: SidebarItem[];
  componentId: string;
  state: BuiltinComponentProps["state"];
  onEvent: BuiltinComponentProps["onEvent"];
  onItemContextMenu?: ItemRowProps["onItemContextMenu"];
  renderChildWithState: BuiltinComponentProps["renderChildWithState"];
}

export function SearchableSidebarSection({
  section,
  items,
  componentId,
  state,
  onEvent,
  onItemContextMenu,
  renderChildWithState,
}: SearchableSidebarSectionProps) {
  const monoItems = section.monoItems === true;
  const grouped = section.groupByPrefix === true;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Always surface the active item even when filtering — losing the
  // currently-selected model out of view feels like a bug. Active item
  // jumps to the top of the visible list when it would otherwise be
  // filtered out.
  const visible = useMemo(() => {
    const filtered = filterItems(items, query);
    const active = items.find((it) => it.active);
    return active && !filtered.some((it) => it.id === active.id) && query.trim()
      ? [active, ...filtered]
      : filtered;
  }, [items, query]);

  const groups = useMemo(() => {
    if (!grouped) return null;
    const map = new Map<string, SidebarItem[]>();
    for (const it of visible) {
      const k = providerOf(it);
      const list = map.get(k) ?? [];
      list.push(it);
      map.set(k, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [grouped, visible]);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="a2ui-sidebar-section">
      <div className="a2ui-sidebar-section-title">{section.title}</div>
      <input
        type="text"
        className="a2ui-sidebar-search"
        placeholder={section.searchPlaceholder ?? `filter ${section.title.toLowerCase()}…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      {visible.length === 0 ? (
        <div className="a2ui-sidebar-empty">no matches</div>
      ) : groups ? (
        <div className="a2ui-sidebar-groups">
          {groups.map(([key, gItems]) => {
            const isCollapsed = collapsed[key] === true;
            return (
              <div key={key} className="a2ui-sidebar-group">
                <button
                  type="button"
                  className="a2ui-sidebar-group-title"
                  onClick={() => toggleGroup(key)}
                  aria-expanded={!isCollapsed}
                >
                  <span className="a2ui-sidebar-group-caret">{isCollapsed ? "▸" : "▾"}</span>
                  <span className="a2ui-sidebar-group-name">{key}</span>
                  <span className="a2ui-sidebar-group-count">{gItems.length}</span>
                </button>
                {!isCollapsed && (
                  <ul className="a2ui-sidebar-list">
                    {gItems.map((item, idx) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        index={idx}
                        monoItems={monoItems}
                        sectionId={section.id}
                        componentId={componentId}
                        onEvent={onEvent}
                        onItemContextMenu={onItemContextMenu}
                        renderChildWithState={renderChildWithState}
                        state={state}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <ul className="a2ui-sidebar-list">
          {visible.map((item, idx) => (
            <ItemRow
              key={item.id}
              item={item}
              index={idx}
              monoItems={monoItems}
              sectionId={section.id}
              componentId={componentId}
              onEvent={onEvent}
              onItemContextMenu={onItemContextMenu}
              renderChildWithState={renderChildWithState}
              state={state}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
