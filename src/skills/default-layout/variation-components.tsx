/**
 * Layout-variation chrome: components used by the four ship-ready layouts
 * (workstation, editorial, command-deck, live-layout). The standard
 * sidebar/tab-strip/status-bar/chat-input live in components.tsx and are
 * shared across variations; this file holds the pieces that only one or two
 * layouts use, so the workstation default doesn't pull them in.
 *
 * Component naming follows the design handoff
 * (`aethon-handoff/handoff/component-contracts.md`): the canonical types
 * are `agent-pulse`, `brand-spine`, `editorial-header`, `command-bar`,
 * `vertical-tab-rail`, `inspector-pane`, `layout-change-pill`,
 * `layout-diff-toast`, `ae-mark`, `ae-ornament`. The legacy aliases
 * (`agent-status-pill`, `editorial-spine`, `canvas-ornament`,
 * `layout-toast`) stay registered so older layout JSONs keep rendering
 * after the rename.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BooleanValue,
  StringValue,
} from "../../types/a2ui";
import {
  resolveBoolean,
  resolveString,
} from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

// ---------------------------------------------------------------------------
// AgentStatusPill — small "agent live"/"agent thinking" indicator. Used in
// the Workstation header (right side) and the Live-Layout header.
// ---------------------------------------------------------------------------

export function AgentStatusPill({
  component,
  state,
}: BuiltinComponentProps) {
  const props = component.props as {
    label?: StringValue;
    /** "live" (green dot) or "thinking" (pulsing accent). */
    state?: StringValue;
  };
  const label = props.label ? resolveString(props.label, state) : "agent live";
  const variant = props.state ? resolveString(props.state, state) : "live";
  return (
    <span className="app-header-pill" data-state={variant}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// EditorialSpine / brand-spine — vertical brand rail used in V2 (Editorial).
// Layout: AeMark on top, vertical Bodoni "ÆTHON · π" text, spacer, then
// three icon buttons at the bottom (skills · commands · terminal).
//
// Mirrors the prototype's V2 spine (aethon-variations.jsx 211-224) so the
// 54px-wide column reads as a brand rail rather than a generic sidebar.
// ---------------------------------------------------------------------------

interface SpineButton {
  id: string;
  icon: string;
  active?: boolean;
}

const SPINE_DEFAULT_BUTTONS: SpineButton[] = [
  { id: "skills", icon: "✺", active: true },
  { id: "commands", icon: "⌘" },
  { id: "terminal", icon: "▣" },
];

export function EditorialSpine({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    buttons?: SpineButton[];
  };
  const title = props.title ? resolveString(props.title, state) : "ÆTHON · π";
  const buttons = Array.isArray(props.buttons) ? props.buttons : SPINE_DEFAULT_BUTTONS;
  return (
    <div className="ae-spine">
      <AeMarkSvg size={28} radius={6} />
      <div className="ae-spine-title">{title}</div>
      <div className="ae-spine-spacer" />
      <div className="ae-spine-buttons">
        {buttons.map((b) => (
          <button
            type="button"
            key={b.id}
            data-active={b.active === true}
            aria-label={b.id}
            title={b.id}
            onClick={() => onEvent("select", { id: b.id })}
          >
            {b.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

// Re-usable inline AeMark for variation chrome (spine, rail header).
// Deliberately co-located with the components that use it so adding a new
// chrome composite doesn't require a registry round-trip.
function AeMarkSvg({ size = 28, radius = 6 }: { size?: number; radius?: number }) {
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
// EditorialHeader — Bodoni-style "Æthon π" title + chapter-style tabs on
// the right. Routes tab clicks through onEvent("select", {tabId}) so the
// existing App.tsx tab routing picks them up (same contract as tab-strip).
// ---------------------------------------------------------------------------

interface TabItem {
  id: string;
  label: string;
  dirty?: boolean;
}

export function EditorialHeader({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    subtitle?: StringValue;
    tabs?: { $ref: string } | TabItem[];
    activeId?: StringValue;
  };
  const title = props.title
    ? resolveString(props.title, state)
    : "Æthon π";
  const subtitle = props.subtitle ? resolveString(props.subtitle, state) : "";
  const tabs: TabItem[] = useMemo(() => {
    if (!props.tabs) return [];
    if (Array.isArray(props.tabs)) return props.tabs;
    const v = resolvePointer(state, props.tabs.$ref);
    return Array.isArray(v) ? (v as TabItem[]) : [];
  }, [props.tabs, state]);
  const activeId = props.activeId ? resolveString(props.activeId, state) : "";

  // Split a "Æthon π" string at the literal "π" so we can italicize+accent
  // just the symbol. Falls back to plain rendering if no π is present.
  const piIdx = title.indexOf("π");
  const before = piIdx >= 0 ? title.slice(0, piIdx) : title;
  const piPart = piIdx >= 0 ? "π" : "";
  const after = piIdx >= 0 ? title.slice(piIdx + 1) : "";

  return (
    <div className="ae-editorial-header">
      <div className="ae-editorial-title">
        <span className="ae-editorial-title-main">
          {before}
          {piPart && <span className="ae-editorial-title-pi">{piPart}</span>}
          {after}
        </span>
        {subtitle && <span className="ae-editorial-subtitle">{subtitle}</span>}
      </div>
      <div className="ae-editorial-tabs" role="tablist">
        {tabs.map((t, i) => {
          const isActive = t.id === activeId;
          const num = String(i + 1).padStart(2, "0");
          // Trim a leading "context · " prefix so chapter titles read as
          // editorial chapters rather than path-style labels.
          const display = t.label.includes("·")
            ? t.label.split("·").slice(1).join("·").trim()
            : t.label;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={isActive}
              data-active={isActive}
              className="ae-editorial-tab"
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest(".ae-editorial-tab-close")) return;
                e.preventDefault();
                onEvent("select", { tabId: t.id });
              }}
            >
              <span className="ae-editorial-tab-meta">
                {num}
                {t.dirty && <span className="ae-dot" />}
              </span>
              <span className="ae-editorial-tab-title">{display}</span>
            </div>
          );
        })}
        <button
          type="button"
          className="ae-editorial-tab-new"
          aria-label="New tab"
          title="New tab"
          onClick={() => onEvent("new")}
        >
          +
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CanvasOrnament — large italic Æ tucked into the canvas corner. Used by
// V2 (Editorial). Pure decoration, pointer-events: none.
// ---------------------------------------------------------------------------

export function CanvasOrnament({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    char?: StringValue;
  };
  const char = props.char ? resolveString(props.char, state) : "Æ";
  return (
    <div className="ae-ornament" aria-hidden="true">
      {char}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommandBar — header command-palette element. Used by V3 (Command Deck) in
// place of a chrome tab strip. Acts as an affordance toward ⌘P/slash; the
// click escalates to the existing slash menu behavior via onEvent.
// ---------------------------------------------------------------------------

export function CommandBar({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    /** Current query text — usually $ref-bound to /commandQuery so the
     *  agent (or a future ⌘K palette) can drive the value. Empty value
     *  shows the placeholder; non-empty renders in --text + a blinking
     *  caret to read like an active editor. */
    text?: StringValue;
    placeholder?: StringValue;
    shortcut?: StringValue;
  };
  const text = props.text ? resolveString(props.text, state) : "";
  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "Search · type / for commands";
  const shortcut = props.shortcut ? resolveString(props.shortcut, state) : "⌘P";
  return (
    <div
      className="ae-command-bar"
      role="button"
      tabIndex={0}
      onClick={() => onEvent("invoke")}
    >
      <span className="ae-command-bar-icon" aria-hidden="true">⌘</span>
      {text ? (
        <span className="ae-command-bar-text">
          {text}
          <span className="ae-command-bar-caret">▍</span>
        </span>
      ) : (
        <span className="ae-command-bar-placeholder">{placeholder}</span>
      )}
      <span className="ae-command-bar-shortcut">{shortcut}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VerticalTabRail — vertical list of session cards used by V3 (Command Deck)
// in place of the chrome tab-strip. Each card shows the tab title + a
// metadata line (model · idle time) when supplied. Routes through the same
// {select,close,new} contract as TabStrip so App.tsx wires them via the
// component id "tab-strip".
// ---------------------------------------------------------------------------

interface RailTab extends TabItem {
  hint?: string;
  /** Subtitle line under the title — e.g. "sonnet · 12 turns" or
   *  "sonnet · idle 3m". Mono, dim. */
  meta?: string;
}

interface RailShelfItem {
  id: string;
  label: string;
  icon?: string;
  /** Optional: when present, treated as a project hint. The rail
   *  surfaces it under the label so a row in the projects shelf shows
   *  both name + path. Sidebar items use the same `hint` field. */
  hint?: string;
  active?: boolean;
}

export function VerticalTabRail({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    tabs?: { $ref: string } | RailTab[];
    activeId?: StringValue;
    title?: StringValue;
    version?: StringValue;
    sectionTitle?: StringValue;
    shelfTitle?: StringValue;
    /** Inline list OR JSON Pointer to a state path. Lets the same shelf
     *  surface either hand-curated entries (icons / labels) or a live
     *  data slice like `/sidebar/projects`. */
    shelfItems?: RailShelfItem[] | { $ref: string };
  };
  const tabs: RailTab[] = useMemo(() => {
    if (!props.tabs) return [];
    if (Array.isArray(props.tabs)) return props.tabs;
    const v = resolvePointer(state, props.tabs.$ref);
    return Array.isArray(v) ? (v as RailTab[]) : [];
  }, [props.tabs, state]);
  const activeId = props.activeId ? resolveString(props.activeId, state) : "";
  const title = props.title ? resolveString(props.title, state) : "aethon";
  const version = props.version ? resolveString(props.version, state) : "";
  const sectionTitle = props.sectionTitle
    ? resolveString(props.sectionTitle, state)
    : "sessions";
  const shelfTitle = props.shelfTitle
    ? resolveString(props.shelfTitle, state)
    : "shelf";
  const shelfItems: RailShelfItem[] = useMemo(() => {
    if (!props.shelfItems) return [];
    if (Array.isArray(props.shelfItems)) return props.shelfItems;
    const v = resolvePointer(state, props.shelfItems.$ref);
    return Array.isArray(v) ? (v as RailShelfItem[]) : [];
  }, [props.shelfItems, state]);

  return (
    <div className="ae-session-rail">
      <div className="ae-session-rail-header">
        <AeMarkSvg size={22} radius={5} />
        <span className="ae-session-rail-header-title">{title}</span>
        {version && (
          <span className="ae-session-rail-header-version">{version}</span>
        )}
        <button
          type="button"
          className="ae-session-rail-new"
          aria-label="New tab"
          title="New tab"
          onClick={() => onEvent("new")}
        >
          +
        </button>
      </div>
      <div className="ae-session-rail-body">
        <div className="ae-session-rail-section">{sectionTitle}</div>
        {tabs.map((t, i) => {
          const isActive = t.id === activeId;
          const num = String(i + 1).padStart(2, "0");
          return (
            <div
              key={t.id}
              data-active={isActive}
              className="ae-session-card"
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest(".ae-session-rail-close")) return;
                e.preventDefault();
                onEvent("select", { tabId: t.id });
              }}
            >
              <div className="ae-session-card-meta">
                <span>tab.{num}</span>
                {t.dirty && <span className="ae-session-card-meta-dot" />}
                <button
                  type="button"
                  className="ae-session-rail-close"
                  aria-label={`Close ${t.label}`}
                  title={`Close ${t.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEvent("close", { tabId: t.id });
                  }}
                >
                  ×
                </button>
              </div>
              <div className="ae-session-card-title">{t.label}</div>
              {t.meta && <div className="ae-session-card-hint">{t.meta}</div>}
              {!t.meta && t.hint && (
                <div className="ae-session-card-hint">{t.hint}</div>
              )}
            </div>
          );
        })}
        {shelfItems.length > 0 && (
          <>
            <div className="ae-session-rail-section">{shelfTitle}</div>
            {shelfItems.map((it) => (
              <div
                key={it.id}
                className={
                  "ae-session-shelf-item" + (it.active ? " ae-session-shelf-item-active" : "")
                }
                onClick={() => onEvent("shelf", { id: it.id })}
              >
                {it.icon && <span className="ae-session-shelf-icon">{it.icon}</span>}
                <div className="ae-session-shelf-text">
                  <span className="ae-session-shelf-label">{it.label}</span>
                  {it.hint && (
                    <span className="ae-session-shelf-hint">{it.hint}</span>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InspectorPane — right-side panel used by V4 (Live Layout). Shows the
// active layout summary, a couple of state KV rows, and a feed of recent
// agent ops. Reads from state pointers so the agent can update any of these
// live by writing to /inspector/...; layouts that don't supply the
// pointers fall back to inline defaults.
// ---------------------------------------------------------------------------

interface InspectorOp {
  text: string;
  when?: string;
}

export function InspectorPane({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    badge?: StringValue;
    layoutSummary?: StringValue;
    layoutSummaryRef?: { $ref: string };
    stateRows?: { label: string; value: StringValue }[] | { $ref: string };
    ops?: InspectorOp[] | { $ref: string };
  };
  const title = props.title ? resolveString(props.title, state) : "Inspector";
  const badge = props.badge ? resolveString(props.badge, state) : "NEW";
  const layoutSummary = props.layoutSummary
    ? resolveString(props.layoutSummary, state)
    : props.layoutSummaryRef
      ? (resolvePointer(state, props.layoutSummaryRef.$ref) as string) ?? ""
      : "";
  // Each row's `value` may be a literal string OR a $ref-bound StringValue.
  // Resolve here so the renderer never receives a raw object as a child.
  type RowInput = { label: string; value: StringValue };
  const stateRowsRaw: RowInput[] = (() => {
    const raw = props.stateRows;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    const v = resolvePointer(state, raw.$ref);
    return Array.isArray(v) ? (v as RowInput[]) : [];
  })();
  const stateRows: { label: string; value: string }[] = stateRowsRaw.map(
    (r) => ({ label: r.label, value: resolveString(r.value, state) }),
  );
  const ops: InspectorOp[] = (() => {
    const raw = props.ops;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    const v = resolvePointer(state, raw.$ref);
    return Array.isArray(v) ? (v as InspectorOp[]) : [];
  })();

  return (
    <aside className="ae-inspector">
      <div className="ae-inspector-header">
        <span className="ae-inspector-header-icon">✺</span>
        <span className="ae-inspector-header-title">{title}</span>
        {badge && <span className="ae-inspector-badge">{badge}</span>}
      </div>
      <div className="ae-inspector-body">
        {layoutSummary && (
          <>
            <div className="ae-inspector-section-label">active layout</div>
            <pre className="ae-inspector-pre">{layoutSummary}</pre>
          </>
        )}
        {stateRows.length > 0 && (
          <>
            <div className="ae-inspector-section-label">state</div>
            <div className="ae-inspector-kv">
              {stateRows.map((row, i) => (
                <div key={i} className="ae-inspector-kv-row">
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {ops.length > 0 && (
          <>
            <div className="ae-inspector-section-label">recent agent ops</div>
            {ops.map((op, i) => (
              <div key={i} className="ae-inspector-op" data-recent={i === 0}>
                <span>{op.text}</span>
                {op.when && <span className="ae-inspector-op-when">{op.when}</span>}
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// AeMark — primitive Æ + π monogram. Used by every layout to render the
// Aethon brand mark inline (sidebar headers, brand spine, tab-rail title).
// Pure SVG; sizes via the `size` prop, otherwise inherits 28px. The dark
// tile + accent dot are tied to CSS custom properties so the palette
// drives colors automatically.
// ---------------------------------------------------------------------------

export function AeMark({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    size?: number;
    radius?: number;
  };
  const size = typeof props.size === "number" ? props.size : 28;
  const radius = typeof props.radius === "number" ? props.radius : 6;
  void state;
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
// LayoutChangePill — live indicator that pulses in the header when the
// agent rewrites the active layout. Auto-pulses via CSS keyframe; visibility
// driven by /layoutChange/visible. Used by Live Layout.
// ---------------------------------------------------------------------------

export function LayoutChangePill({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    visible?: BooleanValue;
    label?: StringValue;
    /** When "agent-rewrite" the pill is sticky-pulsing; when "user-applied"
     *  it's solid (no animation) and dismisses after the next state tick.
     *  Mirrors `LayoutChangePillProps.kind` from the design contract. */
    kind?: StringValue;
  };
  const visible = props.visible === undefined ? true : resolveBoolean(props.visible, state);
  if (!visible) return null;
  const label = props.label
    ? resolveString(props.label, state)
    : "agent rewrote layout · split-view";
  const kind = props.kind ? resolveString(props.kind, state) : "agent-rewrite";
  return (
    <span
      className="ae-live-layout-pill"
      data-kind={kind}
      role="status"
      aria-live="polite"
    >
      <span className="ae-live-layout-pill-icon" aria-hidden="true">✺</span>
      <span className="ae-live-layout-pill-label">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// LayoutToast — sticky notification used by V4 (Live Layout) showing the
// agent just rewrote the active layout, with undo/keep buttons. Routes the
// actions through onEvent so the agent (or App.tsx) decides what to do.
// ---------------------------------------------------------------------------

export function LayoutToast({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    visible?: BooleanValue;
    title?: StringValue;
    diff?: StringValue;
    when?: StringValue;
    undoLabel?: StringValue;
    keepLabel?: StringValue;
    meta?: StringValue;
  };
  const visible = props.visible === undefined ? true : resolveBoolean(props.visible, state);
  if (!visible) return null;
  const title = props.title
    ? resolveString(props.title, state)
    : "aethon.setLayout(splitViewLayout)";
  const diff = props.diff ? resolveString(props.diff, state) : "";
  const when = props.when ? resolveString(props.when, state) : "just now";
  const undoLabel = props.undoLabel ? resolveString(props.undoLabel, state) : "undo";
  const keepLabel = props.keepLabel ? resolveString(props.keepLabel, state) : "keep";
  const meta = props.meta ? resolveString(props.meta, state) : "";

  return (
    <div className="ae-layout-toast" role="status" aria-live="polite">
      <div className="ae-layout-toast-row">
        <span className="ae-layout-toast-row-title">✺ {title}</span>
        <span className="ae-layout-toast-row-when">{when}</span>
      </div>
      {diff && <div className="ae-layout-toast-diff">{diff}</div>}
      <div className="ae-layout-toast-actions">
        <button
          type="button"
          className="ae-layout-toast-btn"
          onClick={() => onEvent("undo")}
        >
          {undoLabel}
        </button>
        <button
          type="button"
          className="ae-layout-toast-btn"
          data-primary="true"
          onClick={() => onEvent("keep")}
        >
          {keepLabel}
        </button>
        {meta && <span className="ae-layout-toast-meta">{meta}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DropdownPicker — generic pulldown button + popover. Used by ModelPicker
// and AppearanceMenu below. Anchors the panel below-right of the trigger
// and closes on outside click / Escape. Items fire a `select` event with
// `{sectionId, itemId}` so the parent App routes by component id +
// section, matching the existing sidebar event shape.
// ---------------------------------------------------------------------------

interface DropdownItem {
  id: string;
  label: string;
  hint?: string;
  active?: boolean;
}

interface DropdownSection {
  id: string;
  title?: string;
  items: DropdownItem[];
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
}

interface DropdownPickerCoreProps {
  buttonLabel: string;
  sections: DropdownSection[];
  align?: "left" | "right";
  className?: string;
  onSelect: (sectionId: string, itemId: string) => void;
}

function DropdownPickerCore({
  buttonLabel,
  sections,
  align = "right",
  className,
  onSelect,
}: DropdownPickerCoreProps) {
  const [open, setOpen] = useState(false);
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    right: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Single close path so the search box always resets when the panel
  // dismisses (outside click, Esc, or item select). Avoids piping that
  // through a useEffect-on-open which would cascade renders.
  const close = () => {
    setOpen(false);
    setQueries({});
    setCoords(null);
  };

  // The chrome controls live inside .a2ui-layout-cell, which clips
  // overflow. To escape that we render the panel with position:fixed
  // and compute coords from the trigger's bounding rect on each open.
  const openPanel = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) {
      setCoords({
        top: r.bottom + 6,
        left: r.left,
        right: window.innerWidth - r.right,
      });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onResize = () => close();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Focus the first searchable input when the panel opens so typing
    // immediately filters — matches the spotlight/Cmd-P feel.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`a2ui-dropdown ${className ?? ""}`.trim()}
      data-open={open ? "true" : "false"}
    >
      <button
        ref={triggerRef}
        type="button"
        className="a2ui-dropdown-trigger"
        onClick={() => (open ? close() : openPanel())}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="a2ui-dropdown-trigger-label">{buttonLabel}</span>
        <span className="a2ui-dropdown-trigger-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && coords && (
        <div
          ref={panelRef}
          className="a2ui-dropdown-panel"
          data-align={align}
          role="listbox"
          style={{
            top: coords.top,
            ...(align === "right"
              ? { right: coords.right }
              : { left: coords.left }),
          }}
        >
          {sections.map((section, sIdx) => {
            const q = (queries[section.id] ?? "").trim().toLowerCase();
            const filtered = q
              ? section.items.filter(
                  (it) =>
                    it.id.toLowerCase().includes(q) ||
                    it.label.toLowerCase().includes(q),
                )
              : section.items;
            return (
              <div className="a2ui-dropdown-section" key={section.id}>
                {section.title && (
                  <div className="a2ui-dropdown-section-title">
                    {section.title}
                  </div>
                )}
                {section.searchable && (
                  <input
                    ref={sIdx === 0 ? searchRef : undefined}
                    type="text"
                    className="a2ui-dropdown-search"
                    placeholder={
                      section.searchPlaceholder ??
                      `filter ${(section.title ?? section.id).toLowerCase()}…`
                    }
                    value={queries[section.id] ?? ""}
                    onChange={(e) =>
                      setQueries((prev) => ({
                        ...prev,
                        [section.id]: e.target.value,
                      }))
                    }
                    spellCheck={false}
                    autoComplete="off"
                  />
                )}
                {filtered.length === 0 ? (
                  <div className="a2ui-dropdown-empty">
                    {section.emptyLabel ?? "no matches"}
                  </div>
                ) : (
                  <ul className="a2ui-dropdown-list">
                    {filtered.map((it) => (
                      <li
                        key={it.id}
                        className={[
                          "a2ui-dropdown-item",
                          it.active ? "a2ui-dropdown-item-active" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => {
                          onSelect(section.id, it.id);
                          close();
                        }}
                        role="option"
                        aria-selected={it.active === true}
                      >
                        <span className="a2ui-dropdown-item-label">
                          {it.label}
                        </span>
                        {it.hint && (
                          <span className="a2ui-dropdown-item-hint">
                            {it.hint}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function asDropdownItems(raw: unknown): DropdownItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((v) => ({
      id: String(v.id ?? ""),
      label: String(v.label ?? v.id ?? ""),
      hint: v.hint != null ? String(v.hint) : undefined,
      active: v.active === true,
    }))
    .filter((it) => it.id.length > 0);
}

// ---------------------------------------------------------------------------
// ModelPicker — pulldown that shows the active model and opens a
// searchable list bound to /sidebar/models. Selecting fires a `select`
// event matching the sidebar shape so App routes to setModel.
// ---------------------------------------------------------------------------

export function ModelPicker({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    source?: { $ref: string } | DropdownItem[];
    active?: StringValue;
    placeholder?: StringValue;
    buttonLabel?: StringValue;
    visible?: BooleanValue;
  };
  const visible = props.visible === undefined ? true : resolveBoolean(props.visible, state);
  if (!visible) return null;

  const sourceRaw = Array.isArray(props.source)
    ? props.source
    : props.source && "$ref" in props.source
      ? resolvePointer(state, props.source.$ref)
      : resolvePointer(state, "/sidebar/models");
  const items = asDropdownItems(sourceRaw);

  const activeId = props.active
    ? resolveString(props.active, state)
    : (resolvePointer(state, "/model") as string | undefined) ?? "";
  const itemsWithActive = items.map((it) => ({
    ...it,
    active: it.id === activeId,
  }));
  const activeItem = itemsWithActive.find((it) => it.id === activeId);

  const buttonLabel = props.buttonLabel
    ? resolveString(props.buttonLabel, state)
    : activeItem?.label || activeId || "model";

  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "filter models — sonnet, gpt, qwen…";

  return (
    <DropdownPickerCore
      className="a2ui-model-picker"
      buttonLabel={buttonLabel}
      align="right"
      sections={[
        {
          id: "models",
          title: "models",
          items: itemsWithActive,
          searchable: true,
          searchPlaceholder: placeholder,
          emptyLabel: "no models match",
        },
      ]}
      onSelect={(sectionId, itemId) =>
        onEvent("select", { sectionId, itemId }, itemId)
      }
    />
  );
}

// ---------------------------------------------------------------------------
// AppearanceMenu — pulldown that groups Layout + Theme switching into a
// single chrome control. Reads /sidebar/layouts and /sidebar/themes; each
// item fires `select` with `{sectionId, itemId}` so App's sidebar handler
// routes to activateLayoutById / setTheme.
// ---------------------------------------------------------------------------

export function AppearanceMenu({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    layoutsSource?: { $ref: string } | DropdownItem[];
    themesSource?: { $ref: string } | DropdownItem[];
    buttonLabel?: StringValue;
    visible?: BooleanValue;
  };
  const visible = props.visible === undefined ? true : resolveBoolean(props.visible, state);
  if (!visible) return null;

  const layoutsRaw = Array.isArray(props.layoutsSource)
    ? props.layoutsSource
    : props.layoutsSource && "$ref" in props.layoutsSource
      ? resolvePointer(state, props.layoutsSource.$ref)
      : resolvePointer(state, "/sidebar/layouts");
  const themesRaw = Array.isArray(props.themesSource)
    ? props.themesSource
    : props.themesSource && "$ref" in props.themesSource
      ? resolvePointer(state, props.themesSource.$ref)
      : resolvePointer(state, "/sidebar/themes");
  const layouts = asDropdownItems(layoutsRaw);
  const themes = asDropdownItems(themesRaw);

  const activeLayout = layouts.find((it) => it.active);
  const activeTheme = themes.find((it) => it.active);

  const buttonLabel = props.buttonLabel
    ? resolveString(props.buttonLabel, state)
    : `${activeLayout?.label ?? "layout"} · ${activeTheme?.label?.split(" — ")[0] ?? "theme"}`;

  return (
    <DropdownPickerCore
      className="a2ui-appearance-menu"
      buttonLabel={buttonLabel}
      align="right"
      sections={[
        {
          id: "layouts",
          title: "layout",
          items: layouts,
          emptyLabel: "no layouts registered",
        },
        {
          id: "themes",
          title: "theme",
          items: themes,
          emptyLabel: "no themes registered",
        },
      ]}
      onSelect={(sectionId, itemId) =>
        onEvent("select", { sectionId, itemId }, itemId)
      }
    />
  );
}
