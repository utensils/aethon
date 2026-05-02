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
import { invoke } from "@tauri-apps/api/core";
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
import type { ShareMode } from "../../utils/shareMode";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import A2UIRenderer, {
  RegistryComponent,
} from "../../components/A2UIRenderer";
import type {
  A2UIEventHandler,
  BuiltinComponentProps,
} from "../../components/A2UIRenderer";

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

function readUiScale(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--app-ui-scale")
    .trim();
  const scale = parseFloat(raw || "1");
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
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

  const columns = props.columns
    ? resolveString(props.columns, state)
    : "minmax(0,1fr)";
  const rows = props.rows ? resolveString(props.rows, state) : "minmax(0,1fr)";
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
  onItemContextMenu?: (
    e: React.MouseEvent<HTMLElement>,
    item: SidebarItem,
    sectionId: string,
  ) => void;
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
  onItemContextMenu,
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
        onContextMenu={(e) => onItemContextMenu?.(e, item, sectionId)}
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
  // Native tooltip — full path / long form. Layouts can set this on
  // any sidebar item; the projects section uses it for the absolute
  // path so the row label stays compact (basename only).
  const tooltip = (item as { tooltip?: string }).tooltip;
  // Per-item git badge — { branch?, dirty?, ahead?, behind? }.
  // Drives a small chip + dirty dot before the hint.
  const git = (item as {
    git?: {
      branch?: string;
      dirty?: boolean;
      ahead?: number;
      behind?: number;
    };
  }).git;
  const branchTitle = git?.branch
    ? `Branch: ${git.branch}${git.dirty ? " (uncommitted changes)" : ""}`
    : undefined;
  return (
    <li
      className={[
        "a2ui-sidebar-item",
        item.active ? "a2ui-sidebar-item-active" : "",
        monoItems ? "a2ui-sidebar-item-mono" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={tooltip}
      onClick={() => onEvent("select", { sectionId, itemId: item.id }, item.id)}
      onContextMenu={(e) => onItemContextMenu?.(e, item, sectionId)}
    >
      {git?.dirty ? (
        <span
          className="a2ui-sidebar-item-git-dot"
          aria-hidden="true"
          title="Uncommitted changes"
        />
      ) : null}
      <span className="a2ui-sidebar-item-label">{item.label}</span>
      {git?.branch ? (
        <span className="a2ui-sidebar-item-git-branch" title={branchTitle}>
          {git.branch}
        </span>
      ) : null}
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
  onItemContextMenu?: ItemRowProps["onItemContextMenu"];
  renderChildWithState: BuiltinComponentProps["renderChildWithState"];
}

interface SidebarContextMenuState {
  x: number;
  y: number;
  sectionId: string;
  itemId: string;
  label: string;
}

function SearchableSidebarSection({
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

// ---------------------------------------------------------------------------
// ToolCard — agent tool-call card with live elapsed-time clock (M6 P4).
//
// Replaces the plain `card` primitive for tool-call rendering so we can:
//   - Show "Running… 3.2s" while the tool is executing (4 Hz updates)
//   - Shift the title amber + add "Long-running command" hint at 30 s
//   - Show "Completed in 12.4s" on natural finish, "Failed in 2.1s" on error
//
// Props match the bridge's existing toolCardPayload shape, with two new
// timestamps. The bridge emits `startedAt` on tool_execution_start and
// `endedAt` on tool_execution_end; if `endedAt` is omitted while
// `startedAt` is set, the card is still running.
// ---------------------------------------------------------------------------

const TOOL_LONG_RUN_THRESHOLD_MS = 30 * 1000;

// eslint-disable-next-line react-refresh/only-export-components -- exported for vitest unit tests; doesn't affect HMR semantics in practice
export function formatToolDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

export function ToolCard({
  component,
  state,
  renderChildren,
}: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    description?: StringValue;
    /** epoch ms — when the tool started executing. */
    startedAt?: NumberValue;
    /** epoch ms — when the tool finished. Omit while running. */
    endedAt?: NumberValue;
    isError?: BooleanValue;
    /** Tool name shown in the title; argsSummary as the description. */
    toolName?: StringValue;
  };
  const baseTitle = props.title ? resolveString(props.title, state) : "";
  const description = props.description
    ? resolveString(props.description, state)
    : undefined;
  const startedAt = props.startedAt
    ? resolveNumber(props.startedAt, state)
    : undefined;
  const endedAt = props.endedAt ? resolveNumber(props.endedAt, state) : undefined;
  const isError = props.isError
    ? resolveBoolean(props.isError, state)
    : false;
  const running = startedAt !== undefined && endedAt === undefined;

  // Tick at 4 Hz while running so the clock stays smooth without
  // thrashing. The interval is cleared on unmount AND on the
  // running→done transition so cards in chat history don't keep
  // timers alive forever.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => window.clearInterval(handle);
  }, [running]);

  const elapsedMs = useMemo(() => {
    if (startedAt === undefined) return 0;
    if (endedAt !== undefined) return Math.max(0, endedAt - startedAt);
    return Math.max(0, now - startedAt);
  }, [startedAt, endedAt, now]);

  const isLongRunning = running && elapsedMs >= TOOL_LONG_RUN_THRESHOLD_MS;

  const titleSuffix = useMemo(() => {
    if (running) return ` · running… ${formatToolDuration(elapsedMs)}`;
    if (isError) return ` · failed in ${formatToolDuration(elapsedMs)}`;
    if (startedAt !== undefined)
      return ` · completed in ${formatToolDuration(elapsedMs)}`;
    return "";
  }, [running, isError, startedAt, elapsedMs]);

  const accentColor = isError
    ? "var(--danger, #c5494a)"
    : isLongRunning
      ? "var(--warning, #d18a2c)"
      : running
        ? "var(--accent)"
        : "var(--text-dim)";

  return (
    <div
      className="ae-tool-card"
      data-running={running ? "true" : "false"}
      data-long-running={isLongRunning ? "true" : "false"}
      data-error={isError ? "true" : "false"}
    >
      <div className="ae-tool-card-title" style={{ color: accentColor }}>
        <span className="ae-tool-card-title-base">{baseTitle}</span>
        <span className="ae-tool-card-title-suffix">{titleSuffix}</span>
      </div>
      {isLongRunning && (
        <div className="ae-tool-card-warning">
          Long-running command — press <kbd>⌘.</kbd> to stop.
        </div>
      )}
      {description && (
        <div className="ae-tool-card-description">{description}</div>
      )}
      {renderChildren && renderChildren()}
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
  const [contextMenu, setContextMenu] =
    useState<SidebarContextMenuState | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  const openItemContextMenu: ItemRowProps["onItemContextMenu"] = (
    e,
    item,
    sectionId,
  ) => {
    if (sectionId !== "projects") return;
    e.preventDefault();
    e.stopPropagation();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    setContextMenu({
      x: Math.min(e.clientX, Math.max(8, viewportWidth - 220)),
      y: Math.min(e.clientY, Math.max(8, viewportHeight - 96)),
      sectionId,
      itemId: item.id,
      label: item.label,
    });
  };

  const removeContextProject = () => {
    if (!contextMenu) return;
    onEvent("remove-project", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
      label: contextMenu.label,
    });
    setContextMenu(null);
  };

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
                onItemContextMenu={openItemContextMenu}
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
                      onItemContextMenu={openItemContextMenu}
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
      {contextMenu &&
        createPortal(
          <div
            className="a2ui-sidebar-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              type="button"
              className="a2ui-sidebar-context-menu-item"
              role="menuitem"
              onClick={removeContextProject}
            >
              Remove from Projects
            </button>
            <div className="a2ui-sidebar-context-menu-note">
              Keeps files on disk
            </div>
          </div>,
          document.body,
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
  // M6 P6 search refinement: when reopening a tab from a search hit,
  // scroll to the first message containing the matched substring
  // instead of the bottom. Driven by `state.scrollToMatchByTab[tabId]`
  // — App.tsx populates this from the search-hit click and clears it
  // after one render so subsequent message arrivals scroll-to-bottom
  // again as usual.
  const scrollToMatchByTab =
    (state.scrollToMatchByTab as Record<string, string> | undefined) ?? {};
  const scrollToMatch = tabId ? scrollToMatchByTab[tabId] : undefined;

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (scrollToMatch && messages.length > 0) {
      const needle = scrollToMatch.toLowerCase();
      const idx = messages.findIndex((m) =>
        (m.text ?? "").toLowerCase().includes(needle),
      );
      if (idx >= 0) {
        const row = el.querySelectorAll(".a2ui-chat-message")[idx];
        if (row instanceof HTMLElement) {
          row.scrollIntoView({ block: "center", behavior: "auto" });
          row.classList.add("a2ui-chat-message-flash");
          window.setTimeout(
            () => row.classList.remove("a2ui-chat-message-flash"),
            1200,
          );
          return;
        }
      }
    }
    el.scrollTop = el.scrollHeight;
    // `messages.length` + `scrollToMatch` capture the cases that should
    // re-run scroll: a new message arrived OR a search hit just landed.
    // The closure also reads each message's text inside `findIndex`,
    // but adding `messages` to deps would re-fire on every text-stream
    // chunk and yank the user back to the match every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, scrollToMatch]);

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
      const scale = readUiScale();
      const viewportWidth = window.innerWidth / scale;
      const viewportHeight = window.innerHeight / scale;
      const left = Math.max(8, Math.min(r.left / scale + 16, viewportWidth - 128));
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
          <svg
            className="a2ui-chat-input-send-icon"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M2 8l11-5-4 11-2-5-5-1z" />
          </svg>
          <span>{sendLabel}</span>
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
      | { id: string; label: string; lastModified?: string; cwd?: string }[]
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
      ? (resolved as { id: string; label: string; lastModified?: string; cwd?: string }[])
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
                    onEvent(
                      "restore-session",
                      { sessionId: s.id, label: s.label, cwd: s.cwd },
                      s.id,
                    )
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
// Theme-aware xterm palette. Reads `--terminal-{bg,fg,cursor,selection}` and
// the 16 `--ansi-*` custom properties off `:root` so xterm picks up the
// active Aethon theme instead of a hardcoded dark palette. Falls back to a
// sensible dark default for any var that isn't defined (e.g. when an
// extension theme didn't ship the ANSI block).
// ---------------------------------------------------------------------------

interface XTermThemeShape {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const ANSI_FALLBACK: XTermThemeShape = {
  background: "#0e0e10",
  foreground: "#e8e8ec",
  cursor: "#7c8cff",
  selectionBackground: "rgba(124, 140, 255, 0.32)",
  black: "#1a1a1c",
  red: "#ff5c4d",
  green: "#6ec85c",
  yellow: "#ffb845",
  blue: "#6ea7ff",
  magenta: "#d97afa",
  cyan: "#5fd5e0",
  white: "#d6cfc1",
  brightBlack: "#4a4a4f",
  brightRed: "#ff7a6f",
  brightGreen: "#88dd75",
  brightYellow: "#ffc870",
  brightBlue: "#8fbeff",
  brightMagenta: "#e69dff",
  brightCyan: "#82e1ea",
  brightWhite: "#fef3e2",
};

function readTerminalTheme(): XTermThemeShape {
  if (typeof window === "undefined") return ANSI_FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => {
    const raw = cs.getPropertyValue(name).trim();
    return raw.length > 0 ? raw : fallback;
  };
  return {
    background: v("--terminal-bg", ANSI_FALLBACK.background),
    foreground: v("--terminal-fg", ANSI_FALLBACK.foreground),
    cursor: v("--terminal-cursor", ANSI_FALLBACK.cursor),
    selectionBackground: v(
      "--terminal-selection",
      ANSI_FALLBACK.selectionBackground,
    ),
    black: v("--ansi-black", ANSI_FALLBACK.black),
    red: v("--ansi-red", ANSI_FALLBACK.red),
    green: v("--ansi-green", ANSI_FALLBACK.green),
    yellow: v("--ansi-yellow", ANSI_FALLBACK.yellow),
    blue: v("--ansi-blue", ANSI_FALLBACK.blue),
    magenta: v("--ansi-magenta", ANSI_FALLBACK.magenta),
    cyan: v("--ansi-cyan", ANSI_FALLBACK.cyan),
    white: v("--ansi-white", ANSI_FALLBACK.white),
    brightBlack: v("--ansi-bright-black", ANSI_FALLBACK.brightBlack),
    brightRed: v("--ansi-bright-red", ANSI_FALLBACK.brightRed),
    brightGreen: v("--ansi-bright-green", ANSI_FALLBACK.brightGreen),
    brightYellow: v("--ansi-bright-yellow", ANSI_FALLBACK.brightYellow),
    brightBlue: v("--ansi-bright-blue", ANSI_FALLBACK.brightBlue),
    brightMagenta: v("--ansi-bright-magenta", ANSI_FALLBACK.brightMagenta),
    brightCyan: v("--ansi-bright-cyan", ANSI_FALLBACK.brightCyan),
    brightWhite: v("--ansi-bright-white", ANSI_FALLBACK.brightWhite),
  };
}

/** Watch `:root[data-theme]` for changes and re-skin a live xterm instance.
 *  Call from the xterm useEffect; returns a cleanup that disconnects the
 *  observer. The xterm `theme` setter triggers an immediate re-render so
 *  switching themes mid-session updates running shells. */
function observeTerminalTheme(term: XTerm): () => void {
  if (typeof window === "undefined") return () => {};
  const apply = () => {
    try {
      term.options.theme = readTerminalTheme();
    } catch {
      /* term disposed mid-update — drop */
    }
  };
  const obs = new MutationObserver(apply);
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => obs.disconnect();
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
  // Default header explicitly distinguishes this read-only agent-bash
  // panel from the new interactive shell tabs (M6 P1 — Cmd+T). Without
  // the contrast, users see two terminals and assume one is broken.
  const headerLabel = props.headerLabel
    ? resolveString(props.headerLabel, state)
    : "Agent bash · read-only";
  const bootGreeting = props.bootGreeting
    ? resolveString(props.bootGreeting, state)
    : "Agent bash output appears here while the agent runs commands.\r\n" +
      "Press ⌘T for an interactive shell tab.\r\n\r\n";
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

    const baseTheme = readTerminalTheme();
    const term = new XTerm({
      fontSize,
      cols,
      rows,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: readOnly
        ? // Hide the cursor in read-only mode by drawing it the same colour
          // as the background — xterm.js doesn't expose a `cursor.hide` flag.
          { ...baseTheme, cursor: baseTheme.background }
        : baseTheme,
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
        // `term.reset()` wipes both the visible viewport AND the
        // scrollback ring; `term.clear()` only scrolls visible lines
        // off the top, leaving the prior buffer reachable via
        // mouse-scroll. Without reset, switching back to agent-bash
        // would stack the boot greeting (from mount) on top of the
        // replayed greeting (from this handler) — visible to the user
        // as a double-banner.
        term.reset();
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
    const stopThemeObserver = observeTerminalTheme(term);

    return () => {
      ro.disconnect();
      stopThemeObserver();
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
  /** True when an LLM turn is in flight on this tab. Drives the
   *  dirty-style dot prefix so the user sees which tabs are working
   *  even when they're not focused. */
  waiting?: boolean;
  /** Pending follow-up count behind the active prompt. Adds a small
   *  numeric chip after the label when > 0. */
  queueCount?: number;
  /** "agent" (chat session) or "shell" (interactive PTY). Shell tabs
   *  no longer render in the top tab strip — they live in the bottom
   *  terminal panel as sub-tabs alongside the read-only agent-bash
   *  view. The TabStrip composite filters them out so any layout that
   *  binds `/tabs` to TabStrip drops shells automatically. */
  kind?: "agent" | "shell";
}

// ---------------------------------------------------------------------------
// TerminalPanel — tabbed bottom-of-screen terminal area (M6 restructure).
//
// Replaces the standalone Terminal composite in the workstation layout's
// `terminal` cell. The panel hosts:
//   - One always-present "Agent bash" sub-tab (read-only sink for the
//     agent's bash-tool output — same content the old solo Terminal showed).
//   - Zero or more user shell sub-tabs (interactive PTYs spawned via
//     `Cmd+T` while focus is in the panel, or `Cmd+Shift+T` regardless).
//
// Active sub-tab is tracked at `/terminalPanel/activeSubId`, defaulting to
// "agent-bash". Switching sub-tabs unmounts/remounts the inner xterm so
// per-sub-tab scrollback isolation is automatic.
// ---------------------------------------------------------------------------

const AGENT_BASH_SUB_ID = "agent-bash";

interface ShellSubTabItem {
  id: string;
  label: string;
  shellState?: string;
}

export function TerminalPanel({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    visible?: BooleanValue;
    fontSize?: NumberValue;
  };
  const visible = props.visible ? resolveBoolean(props.visible, state) : true;

  // Pull shell sub-tabs out of the unified /tabs list. Shells live in
  // /tabs (same as agent tabs) but render in this panel rather than the
  // top tab strip — the TabStrip composite filters them out.
  const tabsRef = state["tabs"];
  const shellTabs: ShellSubTabItem[] = useMemo(() => {
    const tabs = (tabsRef as
      | Array<{ id: string; kind?: string; label: string; shell?: { shellState?: string } }>
      | undefined) ?? [];
    return tabs
      .filter((t) => t.kind === "shell")
      .map((t) => ({
        id: t.id,
        label: t.label,
        shellState: t.shell?.shellState,
      }));
  }, [tabsRef]);

  // Active sub-tab id. Held under /terminalPanel/activeSubId so it
  // persists across renders and can be addressed via $ref. Defaults to
  // "agent-bash" — the read-only view is always present.
  const panelState =
    (state["terminalPanel"] as { activeSubId?: string } | undefined) ?? {};
  const requestedActiveId = panelState.activeSubId ?? AGENT_BASH_SUB_ID;
  // Clamp to a valid sub-tab id. If the requested id no longer exists
  // (e.g. user closed a shell that was active), fall back to agent-bash
  // so we always render something.
  const activeSubId = useMemo(() => {
    if (requestedActiveId === AGENT_BASH_SUB_ID) return AGENT_BASH_SUB_ID;
    if (shellTabs.some((s) => s.id === requestedActiveId))
      return requestedActiveId;
    return AGENT_BASH_SUB_ID;
  }, [requestedActiveId, shellTabs]);

  if (!visible) return null;

  return (
    <div className="ae-terminal-panel" style={{ gridArea: "terminal" }}>
      <div className="ae-terminal-panel-tabs" role="tablist">
        <SubTabPill
          id={AGENT_BASH_SUB_ID}
          label="Agent bash"
          hint="read-only"
          active={activeSubId === AGENT_BASH_SUB_ID}
          onSelect={() =>
            onEvent("select-sub-tab", { subTabId: AGENT_BASH_SUB_ID })
          }
        />
        {shellTabs.map((s, i) => (
          <SubTabPill
            key={s.id}
            id={s.id}
            label={s.label || `Shell ${i + 1}`}
            hint={s.shellState === "exited" ? "exited" : undefined}
            active={activeSubId === s.id}
            closable
            onSelect={() => onEvent("select-sub-tab", { subTabId: s.id })}
            onClose={() => onEvent("close-sub-tab", { subTabId: s.id })}
          />
        ))}
        <button
          type="button"
          className="ae-terminal-panel-new"
          aria-label="New shell"
          title="New shell tab (⌘T while focused here)"
          onClick={() => onEvent("new-shell-sub-tab")}
        >
          +
        </button>
      </div>
      <div className="ae-terminal-panel-body">
        {activeSubId === AGENT_BASH_SUB_ID ? (
          <Terminal
            component={{
              id: `${component.id}-agent-bash`,
              type: "terminal",
              props: {
                fontSize: props.fontSize ?? 13,
                subscribeToBash: true,
                readOnly: true,
              },
            }}
            state={state}
            onEvent={onEvent}
          />
        ) : (
          <ShellCanvas
            component={{
              id: `${component.id}-shell-${activeSubId}`,
              type: "shell-canvas",
              props: {
                tabId: activeSubId,
                fontSize: props.fontSize ?? 13,
              },
            }}
            state={state}
            onEvent={onEvent}
          />
        )}
      </div>
    </div>
  );
}

function SubTabPill(props: {
  id: string;
  label: string;
  hint?: string;
  active: boolean;
  closable?: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  const { label, hint, active, closable, onSelect, onClose } = props;
  return (
    <div
      role="tab"
      aria-selected={active}
      className={
        active ? "ae-sub-tab ae-sub-tab-active" : "ae-sub-tab"
      }
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest(".ae-sub-tab-close")) return;
        e.preventDefault();
        onSelect();
      }}
    >
      <span className="ae-sub-tab-label">{label}</span>
      {hint && <span className="ae-sub-tab-hint">{hint}</span>}
      {closable && (
        <button
          type="button"
          className="ae-sub-tab-close"
          aria-label={`Close ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose?.();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShellCanvas — interactive PTY-backed terminal for shell tabs (M6 P1).
// Distinct from Terminal: this composite has bidirectional input (term.onData
// invokes shell_input) and is bound to a specific shell-tab id (so it can
// subscribe to per-tab `aethon:shell-output:<tabId>` events and resize the
// matching PTY via shell_resize). Mounts a fresh xterm per tabId — switching
// tabs unmounts/remounts so scrollback isolation is automatic.
// ---------------------------------------------------------------------------

export function ShellCanvas({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    /** Shell tab id this canvas is bound to. Resolved via $ref so the
     *  layout can pass `/activeTabId` and have the canvas track the
     *  active shell tab automatically. */
    tabId?: StringValue;
    fontSize?: NumberValue;
    bootGreeting?: StringValue;
  };
  const tabId = props.tabId ? resolveString(props.tabId, state) : "";
  const fontSize = props.fontSize ? resolveNumber(props.fontSize, state) : 13;
  const bootGreeting = props.bootGreeting
    ? resolveString(props.bootGreeting, state)
    : "";

  // Pull the bound tab's shell metadata (cwd, command, share mode, dims)
  // so the status line can reflect them live. Read-only — mutations flow
  // through the `onEvent("set-share-mode", ...)` route below.
  type ShellMetaShape = {
    cwd?: string;
    command?: string;
    shareMode?: ShareMode;
    shellState?: string;
  };
  const tabs = (state["tabs"] as
    | Array<{ id: string; kind?: string; shell?: ShellMetaShape }>
    | undefined) ?? [];
  const boundTab = tabs.find((t) => t.id === tabId);
  const shell = boundTab?.shell;

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const tabIdRef = useRef<string>(tabId);
  // Live cols×rows for the status line. Updated in the same ResizeObserver
  // callback that resizes the PTY so the displayed value never drifts.
  const [dims, setDims] = useState<{ cols: number; rows: number } | null>(null);
  useEffect(() => {
    tabIdRef.current = tabId;
  }, [tabId]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (!tabId) return; // no tab bound yet — wait for the layout to populate

    const term = new XTerm({
      fontSize,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      allowProposedApi: true,
      // Theme + ANSI palette read from `--terminal-*` / `--ansi-*`
      // CSS custom properties on `:root`. observeTerminalTheme below
      // re-applies on `data-theme` attribute changes so switching
      // theme mid-session updates running shells.
      theme: readTerminalTheme(),
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL renderer unavailable, using canvas fallback:", err);
    }
    fit.fit();
    if (bootGreeting) term.write(bootGreeting);

    // Keystrokes → shell_input. Send the raw bytes the shell wants to
    // see — xterm gives us the pre-encoded sequence (e.g. "\x1b[A" for up
    // arrow), so we forward verbatim.
    const onDataDisposable = term.onData((data) => {
      void invoke("shell_input", { tabId: tabIdRef.current, data }).catch(
        () => {
          /* PTY closed mid-keystroke — drop silently */
        },
      );
    });

    // Resize: FitAddon recomputes cols/rows on layout changes; tell the
    // PTY too so child processes (vim, less, …) reflow correctly. Mirror
    // the same dims into local state so the status line displays them
    // without a separate poll loop.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const cols = term.cols;
        const rows = term.rows;
        if (cols && rows) {
          setDims((prev) =>
            prev && prev.cols === cols && prev.rows === rows
              ? prev
              : { cols, rows },
          );
          void invoke("shell_resize", {
            tabId: tabIdRef.current,
            cols,
            rows,
          }).catch(() => {
            /* PTY closed — drop */
          });
        }
      } catch {
        /* fit transient errors during teardown */
      }
    });
    ro.observe(containerRef.current);
    const stopThemeObserver = observeTerminalTheme(term);

    // PTY chunks land via per-tab CustomEvent (`aethon:shell-output:<tabId>`).
    // App.tsx dispatches them; we route to xterm.write here.
    const onShellOutput = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.length > 0) {
        term.write(detail);
      }
    };
    const eventName = `aethon:shell-output:${tabId}`;
    window.addEventListener(eventName, onShellOutput);

    // Replay any already-buffered scrollback (when the tab was mounted
    // after some output had already streamed). App.tsx writes buffer to
    // /tabs/<idx>/terminalBuffer; we read it via state.
    const tabs = (state["tabs"] as Array<{ id: string; terminalBuffer?: string }> | undefined) ?? [];
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.terminalBuffer) term.write(tab.terminalBuffer);

    return () => {
      window.removeEventListener(eventName, onShellOutput);
      ro.disconnect();
      stopThemeObserver();
      onDataDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Mount once per tabId — switching tabs creates a new instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  return (
    <div className="ae-shell-canvas-wrap" style={{ gridArea: "canvas" }}>
      <div
        ref={containerRef}
        className="ae-shell-canvas-term"
      />
      <ShellStatusBar
        cwd={shell?.cwd ?? ""}
        command={shell?.command ?? ""}
        shareMode={shell?.shareMode ?? "private"}
        tabId={tabId}
        cols={dims?.cols ?? 0}
        rows={dims?.rows ?? 0}
        state={state}
        onEvent={onEvent}
      />
    </div>
  );
}

// Status line under the shell terminal — cwd · command · share-mode badge ·
// cols×rows. The badge is dispatched through the registry via
// `<RegistryComponent type="share-mode-badge" />` so an extension that
// registered a `share-mode-badge` template via `aethon.registerComponent`
// wins over the default React `ShareModeBadge` (template-first lookup
// for non-primitives). Cycle order + labels live in
// `src/utils/shareMode.ts`.
function ShellStatusBar(props: {
  cwd: string;
  command: string;
  shareMode: ShareMode;
  tabId?: string;
  cols: number;
  rows: number;
  state: Record<string, unknown>;
  onEvent: BuiltinComponentProps["onEvent"];
}) {
  const { cwd, command, shareMode, tabId, cols, rows, state, onEvent } = props;
  const cwdShort = useMemo(() => {
    if (!cwd) return "";
    // Show basename + parent for context (".../aethon" instead of just
    // "aethon"), full path is in the title attribute.
    const parts = cwd.replace(/\/+$/, "").split("/");
    if (parts.length <= 2) return cwd;
    return `…/${parts.slice(-2).join("/")}`;
  }, [cwd]);
  // Live shareMode + tabId pass through componentProps; both the default
  // React badge and any override template see them via component.props.
  const badgeProps = useMemo(
    () => ({ shareMode, tabId }),
    [shareMode, tabId],
  );
  // Adapter: the default React badge fires `cycle-share-mode`, which
  // App.tsx routes from the surrounding shell-canvas. Re-emit through
  // the parent BuiltinComponentProps onEvent so it lands on the
  // shell-canvas channel; inject `tabId` if the badge didn't supply
  // it (the standalone-placement path emits with no data).
  //
  // Returning `true` for `cycle-share-mode` only — every OTHER event
  // type (primitive `click`, `submit`, anything from a custom template
  // with multiple controls) falls through (return false) so the inner
  // renderer dispatches it to the bridge with
  // `templateRootType="share-mode-badge"`. Extension handlers observe
  // those events and drive the cycle (or do whatever else they want).
  // The bridge's `aethon.shells` surface deliberately omits a
  // `setShareMode` — privacy mode flips MUST come from a user gesture
  // routed through here, never from the agent.
  const handleBadgeEvent = useMemo<A2UIEventHandler>(
    () => (_component, eventType, data) => {
      if (eventType !== "cycle-share-mode") return false;
      const payload =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : {};
      onEvent("cycle-share-mode", {
        ...payload,
        tabId: payload.tabId ?? tabId,
      });
      return true;
    },
    [onEvent, tabId],
  );
  const dimsLabel = cols && rows ? `${cols}×${rows}` : "—";
  return (
    <div className="ae-shell-status-bar" role="status">
      {cwdShort && (
        <span className="ae-shell-status-cwd" title={cwd}>
          {cwdShort}
        </span>
      )}
      {command && (
        <>
          <span className="ae-shell-status-sep" aria-hidden="true">·</span>
          <span className="ae-shell-status-cmd">{command}</span>
        </>
      )}
      <span className="ae-shell-status-sep" aria-hidden="true">·</span>
      <RegistryComponent
        type="share-mode-badge"
        state={state}
        onEvent={handleBadgeEvent}
        componentProps={badgeProps}
        tabId={tabId}
      />
      <span className="ae-shell-status-spacer" />
      <span className="ae-shell-status-dims">{dimsLabel}</span>
    </div>
  );
}

export function TabStrip({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    tabs?: { $ref: string } | TabStripItem[];
    activeId?: StringValue;
  };
  const tabs: TabStripItem[] = useMemo(() => {
    if (!props.tabs) return [];
    const raw: TabStripItem[] = Array.isArray(props.tabs)
      ? props.tabs
      : (() => {
          const ref = props.tabs as { $ref?: string };
          if (typeof ref.$ref !== "string") return [];
          const v = resolvePointer(state, ref.$ref);
          return Array.isArray(v) ? (v as TabStripItem[]) : [];
        })();
    // Filter out shell tabs — they render in the bottom terminal panel
    // as sub-tabs (M6 restructure). Records without `kind` predate the
    // discriminator and are treated as agent.
    return raw.filter((t) => t.kind !== "shell");
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
            {t.waiting ? (
              <span
                className="a2ui-tab-busy-dot"
                aria-hidden="true"
                title="Working…"
              />
            ) : null}
            <span className="a2ui-tab-label">{t.label}</span>
            {typeof t.queueCount === "number" && t.queueCount > 0 ? (
              <span
                className="a2ui-tab-queue"
                title={`${t.queueCount} queued`}
              >
                +{t.queueCount}
              </span>
            ) : null}
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
