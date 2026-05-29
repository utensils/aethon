/**
 * Layout-variation chrome: components used by the workstation layout that
 * don't belong in the core composites file. Today this is the agent status
 * pill plus the two header pickers (model + appearance).
 *
 * Component naming follows the design handoff
 * (`aethon-handoff/handoff/component-contracts.md`): the canonical type is
 * `agent-pulse`; the legacy alias `agent-status-pill` stays registered so
 * older layout JSONs keep rendering after the rename.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import type { VcsSlice } from "../../hooks/useVcsStatus";
import { ciMeta, prMeta } from "./sidebar/vcs-presentation";
import { absolutePathFor } from "./sidebar/fileTreeModel";

function readUiScale(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--app-ui-scale")
    .trim();
  const scale = parseFloat(raw || "1");
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

// ---------------------------------------------------------------------------
// AgentStatusPill — small "agent live"/"agent thinking" indicator. Used in
// the Workstation header (right side).
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

export function DropdownPickerCore({
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
    width: number;
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
      const scale = readUiScale();
      const viewportWidth = window.innerWidth / scale;
      const viewportHeight = window.innerHeight / scale;
      const triggerWidth = r.width / scale;
      const panelWidth = Math.min(
        Math.max(triggerWidth, 240),
        Math.max(240, viewportWidth - 16),
      );
      setCoords({
        top: Math.min(r.bottom / scale + 6, Math.max(8, viewportHeight - 8)),
        left: Math.max(8, Math.min(r.left / scale, Math.max(8, viewportWidth - 8))),
        right: Math.max(8, viewportWidth - r.right / scale),
        width: panelWidth,
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
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Focus the first searchable input when the panel opens so typing
    // immediately filters — matches the spotlight/Cmd-P feel.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  const panel =
    open && coords ? (
      <div
        ref={panelRef}
        className="a2ui-dropdown-panel"
        data-align={align}
        role="listbox"
        style={{
          top: coords.top,
          width: coords.width,
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
                    `filter ${(section.title ?? section.id).toLowerCase()}...`
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
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        onSelect(section.id, it.id);
                        close();
                      }}
                      role="option"
                      aria-selected={it.active === true}
                      tabIndex={0}
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
    ) : null;

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
      {panel ? createPortal(panel, document.body) : null}
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

  // Resolution chain: explicit `props.active` → active tab's model
  // (`/model` mirror) → pi default (`/piDefaultModel`, seeded on
  // `ready`). The default fallback covers the no-tab case so the
  // header still shows the user's working model on a fresh boot.
  const activeTabModel = resolvePointer(state, "/model") as string | undefined;
  const piDefaultModel = resolvePointer(state, "/piDefaultModel") as
    | string
    | undefined;
  const activeId = props.active
    ? resolveString(props.active, state)
    : (activeTabModel || piDefaultModel || "");
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

// ---------------------------------------------------------------------------
// VcsStatus — compact header cluster reading the `/vcs` slice: branch (with
// ahead/behind), working-tree change count, PR state, and CI status. PR/CI
// pills open GitHub via the `open-url` event. Hidden gracefully when the
// active root is not a git repo.
// ---------------------------------------------------------------------------

export function VcsStatus({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as { source?: { $ref: string } };
  const vcs =
    (props.source && "$ref" in props.source
      ? (resolvePointer(state, props.source.$ref) as VcsSlice | undefined)
      : (resolvePointer(state, "/vcs") as VcsSlice | undefined)) ?? undefined;

  // No git repo for the active root → render nothing (keeps the header
  // clean on non-repo projects / the overview tab).
  if (!vcs || (!vcs.branch && vcs.changes.total === 0)) return null;

  const pr = prMeta(vcs.pr);
  const ci = ciMeta(vcs.ci);
  const changeTotal = vcs.changes.total;

  const openUrl = (url: string | undefined | null) => {
    if (url) onEvent("open-url", { url });
  };
  const ciUrl =
    vcs.ci?.checks.find((c) => c.conclusion === "failure")?.url ??
    vcs.ci?.checks[0]?.url ??
    vcs.pr?.url ??
    null;

  // Clicking the "N changed" chip opens the (first) changed file in an
  // editor tab. With one change that's the file; with several it's a quick
  // jump to the top of the list (the full set lives in the source-control
  // panel). Paths from git_file_status are relative to the root.
  const firstChanged = vcs.changes.files[0];
  const openChanged = () => {
    if (!vcs.root || !firstChanged) return;
    // Reuse the file tree's separator-aware join so this path is identical
    // to the one the tree emits for the same file (editor-tab dedupe).
    onEvent("file-tree-open", {
      filePath: absolutePathFor(vcs.root, firstChanged.path),
      rootPath: vcs.root,
    });
  };
  const changeTitle =
    changeTotal === 1 && firstChanged
      ? `${firstChanged.path} — open in editor`
      : `${changeTotal} changed files — open the first in editor`;

  return (
    <div className="ae-vcs-cluster" data-loading={vcs.loading ? "true" : undefined}>
      {vcs.branch ? (
        <span className="ae-vcs-chip ae-vcs-branch" title={`On branch ${vcs.branch}`}>
          <span className="ae-vcs-glyph" aria-hidden="true">
            ⎇
          </span>
          <span className="ae-vcs-branch-name">{vcs.branch}</span>
          {vcs.ahead > 0 ? (
            <span className="ae-vcs-aheadbehind" title={`${vcs.ahead} ahead`}>
              ↑{vcs.ahead}
            </span>
          ) : null}
          {vcs.behind > 0 ? (
            <span className="ae-vcs-aheadbehind" title={`${vcs.behind} behind`}>
              ↓{vcs.behind}
            </span>
          ) : null}
        </span>
      ) : null}
      {changeTotal > 0 ? (
        <button
          type="button"
          className="ae-vcs-chip ae-vcs-changes"
          title={changeTitle}
          onClick={openChanged}
          disabled={!firstChanged}
        >
          <span className="ae-vcs-changes-dot" aria-hidden="true" />
          {changeTotal} changed
        </button>
      ) : null}
      {pr && vcs.pr ? (
        <button
          type="button"
          className={`ae-vcs-chip ae-vcs-pr is-${pr.tone}`}
          title={pr.title}
          onClick={() => openUrl(vcs.pr?.url)}
        >
          <span className="ae-vcs-glyph" aria-hidden="true">
            ⊶
          </span>
          PR #{vcs.pr.number}
          <span className="ae-vcs-pr-state">{pr.label}</span>
        </button>
      ) : null}
      {ci ? (
        <button
          type="button"
          className={`ae-vcs-chip ae-vcs-ci is-${ci.tone}`}
          title={ci.title}
          onClick={() => openUrl(ciUrl)}
        >
          <span className="ae-vcs-ci-icon" aria-hidden="true">
            {ci.icon}
          </span>
          CI
        </button>
      ) : null}
    </div>
  );
}
