/**
 * Default-layout skill: A2UI components — Sidebar, ChatHistory, StatusBar,
 * Terminal, Layout (CSS-grid), ChatInput, MainCanvas. Bundled with
 * layout.a2ui.json (same directory) and exposed via `index.ts`.
 *
 * The renderer treats these no differently from agent-emitted components —
 * the default workspace UI uses the exact same path skills will use to ship
 * their own components.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { HighlightedCode } from "../../components/HighlightedCode";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import type {
  A2UIComponent,
  BooleanValue,
  ChatMessage,
  NumberValue,
  SidebarItem,
  SidebarSection,
  StringValue,
} from "../../types/a2ui";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import A2UIRenderer from "../../components/A2UIRenderer";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

// Adapter: react-markdown invokes `code` for both inline AND fenced code
// blocks. We split on whether the parent is `<pre>` (fenced) and route
// the fenced case through Prism + the palette-driven theme. Inline code
// stays as a styled `<code>` so we don't tokenize prose like
// `someFunc()`.
//
// react-markdown wraps fenced blocks in `<pre><code>...</code></pre>`,
// so we ALSO override `pre`: when its only child is the highlighted-code
// adapter (a fenced block we produced), we render the child directly so
// the output isn't `<pre><pre>...</pre></pre>` (invalid + double-padded).
function isHighlightedFenceChild(node: React.ReactNode): boolean {
  if (!node || typeof node !== "object") return false;
  const el = node as React.ReactElement<{ "data-highlighted-fence"?: boolean }>;
  return el.props?.["data-highlighted-fence"] === true;
}

const MARKDOWN_COMPONENTS = {
  pre({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) {
    if (isHighlightedFenceChild(children)) {
      return <>{children}</>;
    }
    return <pre {...rest}>{children}</pre>;
  },
  code({
    inline,
    className,
    children,
    node,
    ...rest
  }: {
    inline?: boolean;
    className?: string;
    children?: React.ReactNode;
    node?: { tagName?: string };
  } & React.HTMLAttributes<HTMLElement>) {
    void node;
    const text = String(children ?? "").replace(/\n$/, "");
    const langMatch = /language-([\w+-]+)/.exec(className ?? "");
    if (inline || !langMatch) {
      return <code className={className} {...rest}>{children}</code>;
    }
    return (
      <HighlightedFence code={text} language={langMatch[1]} />
    );
  },
};

// Wrapper that tags the rendered element with a data attribute so the
// `pre` override above can detect "this is our fenced output" and
// unwrap the outer markdown `<pre>`.
function HighlightedFence({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  return (
    <span data-highlighted-fence style={{ display: "block" }}>
      <HighlightedCode code={code} language={language} />
    </span>
  );
}

// Inline Æπ monogram — used by Sidebar / TabRail / etc. without going
// through the A2UI registry (so brand-chrome inside a composite doesn't
// require a payload to declare an `ae-mark` child).
function AeMarkInline({ size = 20, radius = 4 }: { size?: number; radius?: number }) {
  return (
    <svg
      className="ae-mark"
      width={size}
      height={size}
      viewBox="0 0 320 320"
      role="img"
      aria-label="Aethon"
      style={{ display: "block", borderRadius: radius, flexShrink: 0 }}
    >
      <title>Aethon</title>
      <rect width="320" height="320" rx="60" fill="var(--bg-elev, #1f1f23)" />
      <text
        x="152"
        y="160"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily='"Playfair Display", "Bodoni 72", Didot, Georgia, serif'
        fontSize="236"
        fontWeight={700}
        fill="var(--text, #fef3e2)"
      >
        Æ
      </text>
      <circle cx="248" cy="82" r="38" fill="var(--accent, #ff6a18)" opacity="0.85" />
      <text
        x="248"
        y="86"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily='"Playfair Display", Didot, Georgia, serif'
        fontSize="44"
        fontWeight={700}
        fontStyle="italic"
        fill="var(--text, #fef3e2)"
      >
        π
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Layout — CSS Grid container with template-areas. Children opt into a region
// by setting their own `area` prop; the layout reads it and wraps the child
// in a div with `grid-area: <area>`.
// ---------------------------------------------------------------------------

export function Layout({
  component,
  state,
  renderChild,
}: BuiltinComponentProps) {
  const props = component.props as {
    columns?: StringValue;
    rows?: StringValue;
    // Inline array OR $ref to a state-bound array. Bound form lets the
    // grid template-areas swap reactively when the user toggles a layout
    // option (e.g. show/hide the sidebar) without requiring a full
    // setLayout replacement.
    areas?: string[] | { $ref: string };
    gap?: NumberValue;
    // Optional slot → grid-area remap. By default a child's `slot` prop
    // resolves to a grid area of the same name; this map lets a layout
    // host the standard composites under non-canonical area names. See
    // `./slots.json` for the canonical slot list.
    slotMap?: Record<string, string>;
  };

  const columns = props.columns ? resolveString(props.columns, state) : "1fr";
  const rows = props.rows ? resolveString(props.rows, state) : "1fr";
  const gap = props.gap ? resolveNumber(props.gap, state) : 0;
  const resolvedAreas = (() => {
    const a = props.areas;
    if (!a) return undefined;
    if (Array.isArray(a)) return a;
    if (typeof a === "object" && "$ref" in a) {
      const v = resolvePointer(state, a.$ref);
      return Array.isArray(v) ? (v as string[]) : undefined;
    }
    return undefined;
  })();
  const areas = resolvedAreas ? resolvedAreas.map((row) => `"${row}"`).join(" ") : undefined;
  const slotMap = props.slotMap ?? {};

  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: columns,
    gridTemplateRows: rows,
    gridTemplateAreas: areas,
    gap: `${gap}px`,
    height: "100%",
    width: "100%",
    minHeight: 0,
  };

  return (
    <div className="a2ui-layout" style={style}>
      {component.children?.map((child) => {
        const childProps = child.props as
          | { area?: string; visible?: BooleanValue }
          | undefined;
        // The child's `area` prop doubles as the slot name. By default the
        // slot name IS the CSS grid area; an optional slotMap on the root
        // layout lets a non-canonical layout host the standard composites
        // under a different grid area name (e.g. slotMap.composer = "bottom").
        // See `./slots.json` for the canonical slot list.
        const slotName = childProps?.area;
        const area = slotName ? (slotMap[slotName] ?? slotName) : undefined;
        const visible =
          childProps?.visible === undefined
            ? true
            : resolveBoolean(childProps.visible, state);
        const cellStyle: CSSProperties = {
          gridArea: area,
          minWidth: 0,
          minHeight: 0,
          display: visible ? "flex" : "none",
        };
        return (
          <div key={child.id} className="a2ui-layout-cell" style={cellStyle}>
            {renderChild?.(child)}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar — collapsible panel with named sections. Items can be inline arrays
// or bound to state via a $ref.
// ---------------------------------------------------------------------------

// Extracts the leading "provider" segment from an item id like
// `claude-sonnet-4-5` → "claude" or `gpt-5-pro` → "gpt". Falls back to
// label-derived prefix; returns "other" when there's nothing useful.
function providerOf(item: SidebarItem): string {
  const id = item.id ?? "";
  const dash = id.indexOf("-");
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash).toLowerCase();
  if (dash > 0) return id.slice(0, dash).toLowerCase();
  if (id) return id.toLowerCase();
  return "other";
}

// Filter helper used by the searchable sidebar section. Matches against
// the item id AND label so a user can find `claude-sonnet-4-5` by typing
// "sonnet". Empty query returns the full list unchanged.
function filterItems(items: SidebarItem[], query: string): SidebarItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    const id = (it.id ?? "").toLowerCase();
    const label = (it.label ?? "").toLowerCase();
    return id.includes(q) || label.includes(q);
  });
}

// Section render helper — extracted so the Sidebar component below can
// fold both "regular" and "searchable" sections through one path.
interface ItemRowProps {
  item: SidebarItem;
  monoItems: boolean;
  sectionId: string;
  componentId: string;
  onEvent: BuiltinComponentProps["onEvent"];
  renderChildWithState: BuiltinComponentProps["renderChildWithState"];
  state: BuiltinComponentProps["state"];
  index: number;
}
function ItemRow({
  item,
  monoItems,
  sectionId,
  componentId,
  onEvent,
  renderChildWithState,
  state,
  index,
}: ItemRowProps) {
  if (item.componentType && renderChildWithState) {
    const synthetic: A2UIComponent = {
      id: `${componentId}__sec_${sectionId}__item_${item.id}`,
      type: item.componentType,
    };
    return (
      <li
        className="a2ui-sidebar-item a2ui-sidebar-item-custom"
        onClick={() =>
          onEvent("select", { sectionId, itemId: item.id }, item.id)
        }
      >
        {renderChildWithState(synthetic, {
          $item: item,
          $index: index,
          $parent: state,
        })}
      </li>
    );
  }
  const hint = (item as { hint?: string }).hint;
  return (
    <li
      className={[
        "a2ui-sidebar-item",
        item.active ? "a2ui-sidebar-item-active" : "",
        monoItems ? "a2ui-sidebar-item-mono" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => onEvent("select", { sectionId, itemId: item.id }, item.id)}
    >
      <span className="a2ui-sidebar-item-label">{item.label}</span>
      {hint && <span className="a2ui-sidebar-item-hint">{hint}</span>}
    </li>
  );
}

interface SidebarSectionExt extends SidebarSection {
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

interface SearchableSidebarSectionProps {
  section: SidebarSectionExt;
  items: SidebarItem[];
  componentId: string;
  state: BuiltinComponentProps["state"];
  onEvent: BuiltinComponentProps["onEvent"];
  renderChildWithState: BuiltinComponentProps["renderChildWithState"];
}
function SearchableSidebarSection({
  section,
  items,
  componentId,
  state,
  onEvent,
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
              renderChildWithState={renderChildWithState}
              state={state}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function Sidebar({
  component,
  state,
  onEvent,
  renderChildWithState,
}: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    /** Optional version chip rendered right-aligned in the title row
     *  (e.g. "v0.3"). Mono, dim. Mirrors the design's brand-mark row. */
    version?: StringValue;
    /** When true, render an inline AeMark monogram before the title. */
    brandMark?: BooleanValue;
    sections?: SidebarSectionExt[];
    // Optional list of extra sections appended after the inline `sections`.
    // Bound via $ref so extensions can push into a state path and have
    // their sections appear without modifying the layout payload.
    extraSections?: SidebarSection[] | { $ref: string };
    /** When false, hide the right-edge drag handle. Default true. */
    resizable?: BooleanValue;
  };
  const resizable =
    props.resizable === undefined ? true : resolveBoolean(props.resizable, state);

  const asideRef = useRef<HTMLElement | null>(null);
  // Drag handle. On mousedown we capture the pointer and start emitting
  // `resize` events with the new pixel width. App listens for those and
  // patches the active layout's grid columns. Cleanup on mouseup.
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const aside = asideRef.current;
    if (!aside) return;
    const startX = e.clientX;
    const startWidth = aside.getBoundingClientRect().width;
    const MIN = 180;
    const MAX = 540;
    document.body.classList.add("ae-resizing-sidebar");
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const next = Math.max(MIN, Math.min(MAX, Math.round(startWidth + dx)));
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

  const title = props.title ? resolveString(props.title, state) : "";
  const version = props.version ? resolveString(props.version, state) : "";
  const showBrand = props.brandMark
    ? resolveBoolean(props.brandMark, state)
    : !!title;

  const resolveItems = (
    items: SidebarSection["items"] | undefined,
  ): SidebarItem[] => {
    if (!items) return [];
    if (Array.isArray(items)) return items;
    if (typeof items !== "object" || !("$ref" in items)) return [];
    const resolved = resolvePointer(state, items.$ref);
    return Array.isArray(resolved) ? (resolved as SidebarItem[]) : [];
  };

  // Resolve the extra-sections list (inline array or $ref). Both lists
  // share the same SidebarSection shape so they render with the same
  // section/item path.
  const extraSections: SidebarSection[] = (() => {
    const raw = props.extraSections;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    const resolved = resolvePointer(state, raw.$ref);
    return Array.isArray(resolved) ? (resolved as SidebarSection[]) : [];
  })();
  const allSections: SidebarSectionExt[] = [
    ...(props.sections ?? []),
    ...(extraSections as SidebarSectionExt[]),
  ];

  return (
    <aside ref={asideRef} className="a2ui-sidebar">
      {(title || version) && (
        <div className="a2ui-sidebar-title">
          {showBrand && <AeMarkInline size={20} radius={4} />}
          {title && <span>{title}</span>}
          {version && (
            <span className="a2ui-sidebar-title-version">{version}</span>
          )}
        </div>
      )}
      <div className="a2ui-sidebar-sections">
        {allSections.map((section) => {
          const items = resolveItems(section.items);
          const monoItems = section.monoItems === true;
          if (section.searchable === true || section.groupByPrefix === true) {
            return (
              <SearchableSidebarSection
                key={section.id}
                section={section}
                items={items}
                componentId={component.id}
                state={state}
                onEvent={onEvent}
                renderChildWithState={renderChildWithState}
              />
            );
          }
          const actions = section.actions ?? [];
          return (
            <div key={section.id} className="a2ui-sidebar-section">
              <div className="a2ui-sidebar-section-title">{section.title}</div>
              {items.length === 0 ? (
                <div className="a2ui-sidebar-empty">empty</div>
              ) : (
                <ul className="a2ui-sidebar-list">
                  {items.map((item, idx) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      index={idx}
                      monoItems={monoItems}
                      sectionId={section.id}
                      componentId={component.id}
                      onEvent={onEvent}
                      renderChildWithState={renderChildWithState}
                      state={state}
                    />
                  ))}
                </ul>
              )}
              {actions.length > 0 && (
                <ul className="a2ui-sidebar-actions">
                  {actions.map((a) => (
                    <li
                      key={a.id}
                      className="a2ui-sidebar-action"
                      onClick={() =>
                        onEvent("select", { sectionId: section.id, itemId: a.id }, a.id)
                      }
                    >
                      {a.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {resizable && (
        <div
          className="a2ui-sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={onResizeStart}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// ChatHistory — scrollable message feed. Messages can be plain text or
// embedded A2UI subtrees (rendered recursively).
// ---------------------------------------------------------------------------

export function ChatHistory({ component, state, tabId }: BuiltinComponentProps) {
  const props = component.props as {
    messages: { $ref: string };
    emptyHint?: StringValue;
  };

  const listRef = useRef<HTMLDivElement>(null);
  const messages = (resolvePointer(state, props.messages.$ref) as ChatMessage[]) || [];
  const emptyHint = props.emptyHint
    ? resolveString(props.emptyHint, state)
    : "Send a message to start a conversation.";

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div className="a2ui-chat-history" ref={listRef}>
      {messages.length === 0 ? (
        <div className="a2ui-chat-empty">{emptyHint}</div>
      ) : (
        messages.map((m) => (
          <div key={m.id} className={`a2ui-chat-message ${m.role}`}>
            <span className="a2ui-chat-role">{m.role}</span>
            {m.text && (
              <div className="a2ui-chat-text a2ui-markdown">
                <ReactMarkdown components={MARKDOWN_COMPONENTS}>{m.text}</ReactMarkdown>
              </div>
            )}
            {/* tabId forwards so clicks inside the embedded card route
                back to the originating tab's pi session. */}
            {m.a2ui && <A2UIRenderer payload={m.a2ui} state={state} tabId={tabId} />}
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MainCanvas — the slot where agent-emitted A2UI flows in. Renders a chat
// feed (history) plus a live "current canvas" subtree if state.canvas is set.
// ---------------------------------------------------------------------------

export function MainCanvas({ component, state, tabId }: BuiltinComponentProps) {
  const props = component.props as {
    slot?: string;
    messages?: { $ref: string };
    /** Text shown when the canvas has no messages and no live subtree.
     *  Lifted out of inline JSX so brand/voice can be overridden via $ref
     *  without forking the composite. */
    emptyHint?: StringValue;
  };

  const messages = props.messages
    ? ((resolvePointer(state, props.messages.$ref) as ChatMessage[]) || [])
    : [];

  const live = props.slot ? resolvePointer(state, props.slot) : null;
  const liveSubtree =
    live && typeof live === "object" && "components" in (live)
      ? (live as { components: A2UIComponent[] })
      : null;

  const emptyHint = props.emptyHint
    ? resolveString(props.emptyHint, state)
    : "The agent's canvas is empty. Send a message to populate it.";

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, liveSubtree]);

  return (
    <main className="a2ui-canvas" ref={listRef}>
      {messages.length === 0 && !liveSubtree && (
        <div className="a2ui-canvas-empty">{emptyHint}</div>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`a2ui-canvas-message ${m.role}`}>
          <span className="a2ui-canvas-role">{m.role}</span>
          {m.text && (
            <div className="a2ui-canvas-text a2ui-markdown">
              <ReactMarkdown>{m.text}</ReactMarkdown>
            </div>
          )}
          {m.a2ui && <A2UIRenderer payload={m.a2ui} state={state} tabId={tabId} />}
        </div>
      ))}
      {liveSubtree && (
        <div className="a2ui-canvas-live">
          <A2UIRenderer payload={liveSubtree} state={state} tabId={tabId} />
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// ChatInput — single-line composer. Submits via onSubmit event with `{ value }`.
// ---------------------------------------------------------------------------

interface SlashCommandHint {
  name: string;
  description?: string;
  usage?: string;
  /** JSON Pointer into App state. When set, the picker fetches the array
   *  at this path the moment the user types `/<name> ` and surfaces the
   *  entries as completions. Each entry can be a `{value,label}`,
   *  `{id,label}`, or a plain string — the picker normalizes all three. */
  argSource?: string;
}

interface SlashArgChoice {
  value: string;
  label?: string;
  description?: string;
  hint?: string;
}

// Normalize the arg-source array into a uniform `{value,label,description,hint}`
// shape. Accepts the most common input forms (slash-arg objects, sidebar
// items, plain strings) so a layout JSON can point at any list it already
// owns without reshaping the data.
function normalizeArgChoices(raw: unknown): SlashArgChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashArgChoice[] = [];
  for (const r of raw) {
    if (typeof r === "string") {
      out.push({ value: r });
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const value =
      typeof obj.value === "string"
        ? obj.value
        : typeof obj.id === "string"
          ? obj.id
          : "";
    if (!value) continue;
    out.push({
      value,
      label: typeof obj.label === "string" ? obj.label : undefined,
      description:
        typeof obj.description === "string" ? obj.description : undefined,
      hint: typeof obj.hint === "string" ? obj.hint : undefined,
    });
  }
  return out;
}

export function ChatInput({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    value?: StringValue;
    placeholder?: StringValue;
    /** Controls the Send ↔ Stop button swap AND whether submits are
     *  queued (true while a prompt is in flight). The textarea itself
     *  is always editable — pi's followUp queue handles overlapping
     *  prompts so users can keep typing during long turns. */
    disabled?: BooleanValue;
    onSubmit?: string;
    onChange?: string;
    // Slash command suggestions surfaced in a dropdown when the input
    // starts with `/`. Resolved as raw value (not via resolveString) so
    // the array shape comes through intact when bound by $ref.
    commands?: SlashCommandHint[] | { $ref: string };
    /** Count of queued (followUp) messages waiting behind the current
     *  prompt. Renders as a subtle badge so the user knows their
     *  Enter-press landed even though the agent is still working on
     *  the previous one. */
    queueCount?: NumberValue;
    /** Label on the primary (idle-state) button. Default "Send". */
    sendLabel?: StringValue;
    /** Label on the abort (busy-state) button. Default "Stop". */
    stopLabel?: StringValue;
    /** Tooltip on the abort button. Default "Stop the current prompt". */
    stopTitle?: StringValue;
    /** Format string for the queue badge. Use `{n}` placeholder; default
     *  "+{n}". A custom value like "queue: {n}" lets a different brand
     *  voice show through without forking the composite. */
    queueBadgeFormat?: StringValue;
  };

  const value = props.value ? resolveString(props.value, state) : "";
  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "";
  const busy = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const queueCount = props.queueCount ? resolveNumber(props.queueCount, state) : 0;
  const sendLabel = props.sendLabel ? resolveString(props.sendLabel, state) : "Send";
  const stopLabel = props.stopLabel ? resolveString(props.stopLabel, state) : "Stop";
  const stopTitle = props.stopTitle
    ? resolveString(props.stopTitle, state)
    : "Stop the current prompt";
  const queueBadgeFormat = props.queueBadgeFormat
    ? resolveString(props.queueBadgeFormat, state)
    : "+{n}";

  // Resolve the commands list. Supports inline arrays or $ref-bound state.
  const commandsRaw = props.commands;
  const commands: SlashCommandHint[] = useMemo(() => {
    if (!commandsRaw) return [];
    if (Array.isArray(commandsRaw)) return commandsRaw;
    if (typeof commandsRaw === "object" && "$ref" in commandsRaw) {
      const resolved = resolvePointer(state, commandsRaw.$ref);
      return Array.isArray(resolved) ? (resolved as SlashCommandHint[]) : [];
    }
    return [];
  }, [commandsRaw, state]);

  // Tracks the draft value the user pressed Escape on. While the live value
  // matches that snapshot, the picker stays dismissed so Escape doesn't
  // require clearing the input. Editing the draft (any change) re-opens
  // — implemented by clearing the snapshot in an effect when value moves
  // away from it. We can't derive this during render: the snapshot must
  // *not* re-suppress the picker when the user backspaces back to the
  // same value, so we need a one-shot reset that fires on every value
  // change. The React 19 lint rule flags setState-in-effect, but here
  // it's the cleanest expression of the semantic.
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  useEffect(() => {
    if (dismissedDraft !== null && value !== dismissedDraft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissedDraft(null);
    }
  }, [value, dismissedDraft]);

  // Slash autocomplete operates in two modes:
  //   1. command-mode  — `/foo` (no space yet)        → suggest matching commands
  //   2. arg-mode      — `/<cmd> <prefix>` (one space) → suggest values from the
  //                                                       command's argSource state path
  // Both use the same picker UI; each match shape is normalized to a
  // common interface so the renderer below doesn't branch.
  type CommandMatch = { kind: "command"; cmd: SlashCommandHint };
  type ArgMatch = { kind: "arg"; cmd: SlashCommandHint; choice: SlashArgChoice };
  type PickerMatch = CommandMatch | ArgMatch;

  const slashMatch = useMemo((): {
    mode: "command" | "arg";
    prefix: string;
    matches: PickerMatch[];
    cmd?: SlashCommandHint;
  } | null => {
    if (dismissedDraft !== null && value === dismissedDraft) return null;
    // Command mode: just the slash + an optional partial name, no space.
    const cmdM = value.match(/^\/([A-Za-z][\w-]*)?$/);
    if (cmdM) {
      const prefix = (cmdM[1] ?? "").toLowerCase();
      const matches: PickerMatch[] = commands
        .filter((c) => c.name.toLowerCase().startsWith(prefix))
        .map((cmd) => ({ kind: "command", cmd }));
      return matches.length > 0 ? { mode: "command", prefix, matches } : null;
    }
    // Arg mode: `/<cmd> <prefix>` — exactly one space between the
    // command name and the (optionally empty) argument prefix. We
    // intentionally don't support multi-arg commands yet; the spec for
    // those should land alongside the first command that needs it.
    const argM = value.match(/^\/([A-Za-z][\w-]*) ([^\n]*)$/);
    if (argM) {
      const cmdName = argM[1].toLowerCase();
      const argPrefix = argM[2].toLowerCase();
      const cmd = commands.find((c) => c.name.toLowerCase() === cmdName);
      if (!cmd || !cmd.argSource) return null;
      const raw = resolvePointer(state, cmd.argSource);
      const choices = normalizeArgChoices(raw).filter((ch) => {
        const haystack = `${ch.value} ${ch.label ?? ""}`.toLowerCase();
        return haystack.includes(argPrefix);
      });
      const matches: PickerMatch[] = choices.map((choice) => ({
        kind: "arg",
        cmd,
        choice,
      }));
      return matches.length > 0
        ? { mode: "arg", prefix: argPrefix, matches, cmd }
        : null;
    }
    return null;
  }, [value, commands, state, dismissedDraft]);

  const [highlightIdx, setHighlightIdx] = useState(0);
  // Reset highlight when the visible list changes so the cursor stays inside
  // bounds and on the first suggestion for a new prefix.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlightIdx(0);
  }, [slashMatch?.matches.length, slashMatch?.prefix, slashMatch?.mode]);

  // The slash menu is portalled to document.body so it can't be clipped by
  // ancestor `overflow: hidden` (the default-layout grid cell uses that to
  // contain chat history scrolling). Track the chat-input rect so we can
  // anchor the menu in fixed coordinates above it.
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const [menuAnchor, setMenuAnchor] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    if (!slashMatch || !inputContainerRef.current) {
      setMenuAnchor(null);
      return;
    }
    const update = () => {
      const r = inputContainerRef.current!.getBoundingClientRect();
      setMenuAnchor({
        left: r.left + 16,
        bottom: window.innerHeight - r.top + 4,
        width: r.width - 32,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [slashMatch]);

  // Insert the highlighted picker entry — for command-mode that completes
  // to `/<name> ` (cursor primed for an arg); for arg-mode it completes
  // to `/<name> <value>` ready to submit.
  const insertMatch = (m: PickerMatch) => {
    const text =
      m.kind === "command" ? `/${m.cmd.name} ` : `/${m.cmd.name} ${m.choice.value}`;
    onEvent("change", { value: text });
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onEvent("change", { value: e.target.value });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatch) {
      const list = slashMatch.matches;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % list.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + list.length) % list.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        insertMatch(list[highlightIdx] ?? list[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Just dismiss the picker — keep the typed text intact. The
        // dismissedDraft snapshot above re-opens the picker as soon as
        // the user edits the draft again.
        setDismissedDraft(value);
        return;
      }
      // Enter behavior with the picker open:
      //   - command-mode: complete to `/<name> ` (or submit if the draft
      //     already matches a command exactly so the user doesn't have
      //     to press Enter twice).
      //   - arg-mode: insert + submit on the same Enter — the user has
      //     already named the command and chosen a value, so there's
      //     nothing left to do.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const v = (e.target as HTMLTextAreaElement).value;
        if (slashMatch.mode === "arg") {
          const choice = (list[highlightIdx] ?? list[0]) as ArgMatch;
          const submitText = `/${choice.cmd.name} ${choice.choice.value}`;
          onEvent("change", { value: submitText });
          onEvent("submit", { value: submitText });
          return;
        }
        const exact = (list as CommandMatch[]).find(
          (c) => v === `/${c.cmd.name}` || v.startsWith(`/${c.cmd.name} `),
        );
        if (exact && v.trim().length > 0) {
          onEvent("submit", { value: v });
          return;
        }
        insertMatch(list[highlightIdx] ?? list[0]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const v = (e.target as HTMLTextAreaElement).value;
      if (v.trim().length > 0) {
        // Always submit — the bridge uses pi's followUp queue when an
        // earlier prompt is still in flight, so the user can keep
        // typing without "agent busy" rejections.
        onEvent("submit", { value: v });
      }
    }
  };

  const handleClick = () => {
    if (value.trim().length > 0) {
      onEvent("submit", { value });
    }
  };

  const handleStop = () => {
    onEvent("cancel");
  };

  return (
    <div className="a2ui-chat-input" ref={inputContainerRef}>
      {slashMatch && menuAnchor &&
        createPortal(
          <div
            className="a2ui-slash-menu"
            role="listbox"
            style={{
              position: "fixed",
              left: `${menuAnchor.left}px`,
              bottom: `${menuAnchor.bottom}px`,
              width: `${menuAnchor.width}px`,
            }}
          >
            {slashMatch.mode === "arg" && slashMatch.cmd && (
              <div className="a2ui-slash-arg-header">
                <span className="a2ui-slash-arg-cmd">/{slashMatch.cmd.name}</span>
                <span className="a2ui-slash-arg-hint">
                  {slashMatch.cmd.description ?? "select an option"}
                </span>
              </div>
            )}
            {slashMatch.matches.map((m, i) => {
              const key =
                m.kind === "command" ? m.cmd.name : `${m.cmd.name}::${m.choice.value}`;
              return (
                <div
                  key={key}
                  role="option"
                  aria-selected={i === highlightIdx}
                  className={
                    i === highlightIdx
                      ? "a2ui-slash-item a2ui-slash-item-active"
                      : "a2ui-slash-item"
                  }
                  onMouseDown={(e) => {
                    // mousedown (not click) so the textarea doesn't lose focus
                    // before the insertion fires.
                    e.preventDefault();
                    if (m.kind === "arg") {
                      const submitText = `/${m.cmd.name} ${m.choice.value}`;
                      onEvent("change", { value: submitText });
                      onEvent("submit", { value: submitText });
                    } else {
                      insertMatch(m);
                    }
                  }}
                  onMouseEnter={() => setHighlightIdx(i)}
                >
                  {m.kind === "command" ? (
                    <>
                      <span className="a2ui-slash-item-name">/{m.cmd.name}</span>
                      {m.cmd.usage && (
                        <span className="a2ui-slash-item-usage"> {m.cmd.usage}</span>
                      )}
                      {m.cmd.description && (
                        <span className="a2ui-slash-item-desc"> — {m.cmd.description}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="a2ui-slash-item-name">{m.choice.value}</span>
                      {m.choice.label && m.choice.label !== m.choice.value && (
                        <span className="a2ui-slash-item-desc"> — {m.choice.label}</span>
                      )}
                      {m.choice.description && (
                        <span className="a2ui-slash-item-desc"> — {m.choice.description}</span>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
      <textarea
        className="a2ui-chat-input-field"
        rows={2}
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {/* Queue badge — visible when the user has stacked messages behind
          an in-flight prompt. Sits between the textarea and the action
          button so it's near the input but doesn't compete with Stop. */}
      {queueCount > 0 && (
        <span
          className="a2ui-chat-input-queue"
          title={`${queueCount} message${queueCount === 1 ? "" : "s"} queued behind the current prompt`}
        >
          {queueBadgeFormat.replace("{n}", String(queueCount))}
        </span>
      )}
      {busy ? (
        <button
          type="button"
          className="a2ui-chat-input-send a2ui-chat-input-stop"
          onClick={handleStop}
          title={stopTitle}
        >
          {stopLabel}
        </button>
      ) : (
        <button
          type="button"
          className="a2ui-chat-input-send"
          onClick={handleClick}
          disabled={value.trim().length === 0}
        >
          {sendLabel}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusBar — three-region status footer (left/center/right).
// ---------------------------------------------------------------------------

export function StatusBar({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    left?: StringValue;
    center?: StringValue;
    right?: StringValue;
  };

  const left = props.left ? resolveString(props.left, state) : "";
  const center = props.center ? resolveString(props.center, state) : "";
  const right = props.right ? resolveString(props.right, state) : "";

  return (
    <footer className="a2ui-status-bar">
      <span className="a2ui-status-left">{left}</span>
      <span className="a2ui-status-center">{center}</span>
      <span className="a2ui-status-right">{right}</span>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// EmptyState — shown when the tabs array is empty (the user closed every
// open conversation). Lives inside default-layout, NOT inside App.tsx, so
// extensions can swap it for a different welcome screen by registering an
// override with the same component type. Emits "new-tab" on the primary
// button so App's onEvent handler can spin up a fresh tab.
// ---------------------------------------------------------------------------

export function EmptyState({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    subtitle?: StringValue;
    primaryButtonLabel?: StringValue;
    /** Optional ghost-styled secondary button. When set, fires
     *  "open-project" so App can pop the native folder picker. */
    secondaryButtonLabel?: StringValue;
    tips?: StringValue[];
    recentSessions?:
      | { id: string; label: string; lastModified?: string }[]
      | { $ref: string };
    /** Recent projects list — shown alongside recent sessions so the
     *  user can hop between project directories without going through
     *  the picker. Same $ref + inline form as recentSessions. */
    recentProjects?:
      | { id: string; label: string; path: string; active?: boolean }[]
      | { $ref: string };
    /** Currently active project, displayed as a one-line breadcrumb
     *  above the action buttons so the user always knows what cwd a
     *  new tab will inherit. Null when no project is set. */
    activeProject?:
      | { id: string; label: string; path: string }
      | null
      | { $ref: string };
  };
  const title = props.title ? resolveString(props.title, state) : "Welcome to Aethon";
  const subtitle = props.subtitle
    ? resolveString(props.subtitle, state)
    : "All tabs are closed. Open a new one to start a conversation.";
  const primaryLabel = props.primaryButtonLabel
    ? resolveString(props.primaryButtonLabel, state)
    : "New Tab";
  const secondaryLabel = props.secondaryButtonLabel
    ? resolveString(props.secondaryButtonLabel, state)
    : "";
  const tips = props.tips ?? [];
  // Support both inline arrays AND $ref-bound recent-sessions lists so
  // App can push discovered persistent sessions into a single state
  // path (/recentSessions) and have the empty-state pick them up.
  const recentSessionsRaw = props.recentSessions;
  const recentSessions = (() => {
    if (!recentSessionsRaw) return [];
    if (Array.isArray(recentSessionsRaw)) return recentSessionsRaw;
    const resolved = resolvePointer(state, recentSessionsRaw.$ref);
    return Array.isArray(resolved)
      ? (resolved as { id: string; label: string; lastModified?: string }[])
      : [];
  })();
  const recentProjectsRaw = props.recentProjects;
  const recentProjects = (() => {
    if (!recentProjectsRaw) return [];
    if (Array.isArray(recentProjectsRaw)) return recentProjectsRaw;
    const resolved = resolvePointer(state, recentProjectsRaw.$ref);
    return Array.isArray(resolved)
      ? (resolved as { id: string; label: string; path: string; active?: boolean }[])
      : [];
  })();
  const activeProjectRaw = props.activeProject;
  const activeProject = (() => {
    if (!activeProjectRaw) return null;
    if ("$ref" in activeProjectRaw) {
      const r = resolvePointer(state, activeProjectRaw.$ref);
      return r && typeof r === "object" && "label" in r
        ? (r as { id: string; label: string; path: string })
        : null;
    }
    return activeProjectRaw;
  })();

  return (
    <div className="a2ui-empty-state">
      <div className="a2ui-empty-state-card">
        <h1 className="a2ui-empty-state-title">{title}</h1>
        <p className="a2ui-empty-state-subtitle">{subtitle}</p>
        {activeProject && (
          <p className="a2ui-empty-state-active-project">
            <span className="a2ui-empty-state-active-project-label">
              {activeProject.label}
            </span>
            <span className="a2ui-empty-state-active-project-path">
              {activeProject.path}
            </span>
          </p>
        )}
        <div className="a2ui-empty-state-actions">
          <button
            type="button"
            className="a2ui-empty-state-primary"
            onClick={() => onEvent("new-tab")}
          >
            {primaryLabel}
          </button>
          {secondaryLabel && (
            <button
              type="button"
              className="a2ui-empty-state-secondary"
              onClick={() => onEvent("open-project")}
            >
              {secondaryLabel}
            </button>
          )}
        </div>
        {recentProjects.length > 0 && (
          <div className="a2ui-empty-state-recent">
            <h2>Recent projects</h2>
            <ul>
              {recentProjects.map((p) => (
                <li
                  key={p.id}
                  className={p.active ? "a2ui-empty-state-recent-active" : undefined}
                  onClick={() =>
                    onEvent(
                      "select-project",
                      { projectId: p.id, label: p.label, path: p.path },
                      p.id,
                    )
                  }
                >
                  <span className="a2ui-empty-state-recent-label">{p.label}</span>
                  <span className="a2ui-empty-state-recent-meta">{p.path}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {recentSessions.length > 0 && (
          <div className="a2ui-empty-state-recent">
            <h2>Recent sessions</h2>
            <ul>
              {recentSessions.map((s) => (
                <li
                  key={s.id}
                  onClick={() =>
                    // descendantId carries the session id so an extension's
                    // onEvent({componentType:"empty-state", descendantId:"…"})
                    // matcher can target a specific session row.
                    onEvent("restore-session", { sessionId: s.id, label: s.label }, s.id)
                  }
                >
                  <span className="a2ui-empty-state-recent-label">{s.label}</span>
                  {s.lastModified && (
                    <span className="a2ui-empty-state-recent-meta">{s.lastModified}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {tips.length > 0 && (
          <ul className="a2ui-empty-state-tips">
            {tips.map((tip, i) => (
              <li key={i}>{resolveString(tip, state)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal — xterm.js with WebGL renderer. Falls back to canvas if WebGL
// init fails (which it can on some Linux GPUs / older webviews).
// ---------------------------------------------------------------------------

export function Terminal({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    cols?: NumberValue;
    rows?: NumberValue;
    fontSize?: NumberValue;
    output?: StringValue;
    onInput?: string;
    // Opt-in: when true, this instance subscribes to the agent's bash output
    // stream (`aethon:terminal` window event). Off by default so skills can
    // mount independent terminals without receiving the agent's bash chatter.
    subscribeToBash?: BooleanValue;
    // Display-only mode: hides the cursor and ignores keystrokes entirely.
    // Aethon ships no PTY backend, so the default terminal panel is a
    // window onto the agent's bash output, not an interactive shell —
    // accepting keystrokes that lead nowhere just confuses users into
    // thinking the panel is broken. Skills with their own input pipeline
    // can opt out by leaving readOnly unset.
    readOnly?: BooleanValue;
    /** Header label shown above the xterm canvas. Lifted out of inline
     *  JSX so brand/voice can be overridden via $ref. */
    headerLabel?: StringValue;
    /** Boot greeting written into the buffer on mount and on tab replay.
     *  Default reads "Aethon Terminal\r\n$ ". Use "" to skip the prompt. */
    bootGreeting?: StringValue;
  };

  const fontSize = props.fontSize ? resolveNumber(props.fontSize, state) : 13;
  const cols = props.cols ? resolveNumber(props.cols, state) : undefined;
  const rows = props.rows ? resolveNumber(props.rows, state) : undefined;
  const subscribeToBash = props.subscribeToBash
    ? resolveBoolean(props.subscribeToBash, state)
    : false;
  const readOnly = props.readOnly
    ? resolveBoolean(props.readOnly, state)
    : false;
  const headerLabel = props.headerLabel
    ? resolveString(props.headerLabel, state)
    : "Aethon Terminal";
  const bootGreeting = props.bootGreeting
    ? resolveString(props.bootGreeting, state)
    : "Aethon Terminal\r\n$ ";
  // Stash boot greeting in a ref so the mount-once effect (which doesn't
  // depend on `bootGreeting`) writes the right initial buffer even if the
  // prop changes later. Replay also reads from this ref so a $ref-driven
  // greeting stays current across tab switches. Update happens inside an
  // effect so React's strict-mode warning about ref-mutation-during-render
  // stays clean.
  const bootGreetingRef = useRef(bootGreeting);
  useEffect(() => {
    bootGreetingRef.current = bootGreeting;
  }, [bootGreeting]);
  // Optional prop-driven output. Skills/A2UI payloads can still bind a `$ref`
  // to drive the terminal via state — the diff effect below handles it the
  // same way it used to. The default layout no longer uses this; bash output
  // arrives via the `aethon:terminal` window event instead.
  const output = props.output ? resolveString(props.output, state) : "";

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastOutputRef = useRef<string>("");

  useEffect(() => {
    if (!containerRef.current) return;
    if (termRef.current) return;

    const term = new XTerm({
      fontSize,
      cols,
      rows,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: {
        background: "#0e0e10",
        foreground: "#e8e8ec",
        // Make the cursor invisible in read-only mode by drawing it the same
        // color as the background — xterm.js doesn't expose a cursor.hide flag.
        cursor: readOnly ? "#0e0e10" : "#7c8cff",
      },
      cursorBlink: !readOnly,
      // disableStdin tells xterm to ignore keystrokes entirely. Without this
      // a focused terminal still calls onData for each keystroke (which we
      // currently dispatch as an a2ui_event with no handler), and any
      // unrelated re-render on the same tick can collapse the panel via
      // the layout's `visible` binding.
      disableStdin: readOnly,
      allowProposedApi: true,
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    term.open(containerRef.current);

    // WebGL renderer — fall back gracefully if context creation fails.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL renderer unavailable, using canvas fallback:", err);
    }

    fit.fit();
    term.write(bootGreetingRef.current);

    // onInput wires xterm's keystroke stream to an A2UI event so a future
    // skill with a real PTY backend can plug in. Skip it in read-only mode
    // to keep the terminal display-only.
    if (props.onInput && !readOnly) {
      term.onData((data) => onEvent("input", { data }));
    }

    // App.tsx fires `aethon:terminal` for live bash output and
    // `aethon:terminal-replay` on tab switch (clear + replay the active
    // tab's buffered scrollback). Only this terminal subscribes when
    // subscribeToBash is true so skills can mount independent terminals
    // without picking up the agent's bash stream.
    let onTerminalEvent: ((e: Event) => void) | null = null;
    let onReplayEvent: ((e: Event) => void) | null = null;
    if (subscribeToBash) {
      onTerminalEvent = (e: Event) => {
        const detail = (e as CustomEvent<string>).detail;
        if (typeof detail === "string" && detail.length > 0) {
          term.write(detail);
        }
      };
      onReplayEvent = (e: Event) => {
        const detail = (e as CustomEvent<string>).detail;
        // Clear restores the prompt-style header line plus the buffered
        // contents for the now-active tab. Empty buffer = fresh prompt.
        term.clear();
        term.write(bootGreetingRef.current);
        if (typeof detail === "string" && detail.length > 0) {
          term.write(detail);
        }
      };
      window.addEventListener("aethon:terminal", onTerminalEvent);
      window.addEventListener("aethon:terminal-replay", onReplayEvent);
    }

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* noop */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      if (onTerminalEvent) {
        window.removeEventListener("aethon:terminal", onTerminalEvent);
      }
      if (onReplayEvent) {
        window.removeEventListener("aethon:terminal-replay", onReplayEvent);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Mount once — terminal output flows through the `aethon:terminal` event,
    // not React props, so we don't list `output` as a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prop-driven write path. When a skill or A2UI payload binds the `output`
  // prop to a state $ref, write deltas to xterm. Append-only diff: when the
  // new value starts with the previous one, write the suffix; otherwise
  // write the full string (treats it as a reset).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (!output || output === lastOutputRef.current) return;
    const delta = output.startsWith(lastOutputRef.current)
      ? output.slice(lastOutputRef.current.length)
      : output;
    term.write(delta);
    lastOutputRef.current = output;
  }, [output]);

  return (
    <div className="a2ui-terminal">
      <div className="a2ui-terminal-header">
        <span>{headerLabel}</span>
      </div>
      <div ref={containerRef} className="a2ui-terminal-mount" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// TabStrip — horizontal row of tab pills + a "+" button to create new ones.
// Each tab shows its label; the active one is highlighted; non-default tabs
// have a small "×" close button. All interactions go through onEvent so
// App.tsx can route them to its tab helpers (newTab / closeTab / switch).
//
// Props:
//   tabs:        $ref to /tabs (array of { id, label }) — items to render
//   activeId:    $ref to /activeTabId — which tab is highlighted
//
// Events:
//   ("select",  { tabId })  click on a tab pill
//   ("close",   { tabId })  click on a tab's close button
//   ("new")                 click on the "+" button
// ---------------------------------------------------------------------------

interface TabStripItem {
  id: string;
  label: string;
}

export function TabStrip({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    tabs?: { $ref: string } | TabStripItem[];
    activeId?: StringValue;
  };
  const tabs: TabStripItem[] = useMemo(() => {
    if (!props.tabs) return [];
    if (Array.isArray(props.tabs)) return props.tabs;
    const ref = props.tabs as { $ref?: string };
    if (typeof ref.$ref === "string") {
      const v = resolvePointer(state, ref.$ref);
      if (Array.isArray(v)) return v as TabStripItem[];
    }
    return [];
  }, [props.tabs, state]);
  const activeId = props.activeId ? resolveString(props.activeId, state) : "";

  return (
    <div className="a2ui-tab-strip" role="tablist">
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        // Every tab is closable now — when the list reaches zero the
        // layout swaps to the empty-state composite (registered by
        // default-layout, not hardcoded React in App.tsx).
        const canClose = true;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={isActive}
            className={
              isActive ? "a2ui-tab a2ui-tab-active" : "a2ui-tab"
            }
            onMouseDown={(e) => {
              // mousedown not click so focus doesn't shift away from the
              // chat input first (avoids a stray blur that could submit
              // a draft). The select handler swaps the active tab.
              if ((e.target as HTMLElement).closest(".a2ui-tab-close")) return;
              e.preventDefault();
              onEvent("select", { tabId: t.id });
            }}
          >
            <span className="a2ui-tab-label">{t.label}</span>
            {canClose && (
              <button
                type="button"
                className="a2ui-tab-close"
                aria-label={`Close ${t.label}`}
                title={`Close ${t.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onEvent("close", { tabId: t.id });
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="a2ui-tab-new"
        title="New tab (⌘T)"
        aria-label="New tab"
        onClick={() => onEvent("new")}
      >
        +
      </button>
    </div>
  );
}
