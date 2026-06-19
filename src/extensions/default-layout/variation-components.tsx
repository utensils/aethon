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
import type { BooleanValue, StringValue } from "../../types/a2ui";
import { resolveBoolean, resolveString } from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import { PI_DEFAULT_MODEL_SENTINEL } from "../../utils/modelPicker";
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

export function AgentStatusPill({ component, state }: BuiltinComponentProps) {
  const props = component.props as {
    label?: StringValue;
    /** "live" (green dot) or "thinking" (pulsing accent). */
    state?: StringValue;
  };
  const label = props.label ? resolveString(props.label, state) : "agent live";
  const variant = props.state ? resolveString(props.state, state) : "live";
  // Non-interactive status text. The window drag-region lives on the header
  // Container (`dragRegion: true` → `data-tauri-drag-region="deep"`), so this
  // pill is draggable by virtue of being a non-clickable header descendant —
  // it needs no attribute of its own.
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
  thinkingLevels?: string[];
  codexFastModeSupported?: boolean;
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
        left: Math.max(
          8,
          Math.min(r.left / scale, Math.max(8, viewportWidth - 8)),
        ),
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
    .filter(
      (v): v is Record<string, unknown> => typeof v === "object" && v !== null,
    )
    .map((v) => ({
      id: String(v.id ?? ""),
      label: String(v.label ?? v.id ?? ""),
      hint: v.hint != null ? String(v.hint) : undefined,
      active: v.active === true,
      thinkingLevels: Array.isArray(v.thinkingLevels)
        ? v.thinkingLevels.filter(
            (level): level is string => typeof level === "string",
          )
        : undefined,
      codexFastModeSupported: v.codexFastModeSupported === true,
    }))
    .filter((it) => it.id.length > 0);
}

// ---------------------------------------------------------------------------
// ModelPicker — pulldown that shows the active model and opens a
// searchable list bound to /sidebar/models. Selecting fires a `select`
// event matching the sidebar shape so App routes to setModel.
// ---------------------------------------------------------------------------

// Sentinel that flips the picker into a free-text input for a model id
// not on the loaded list. Local to the picker — custom ids resolve to a
// real id before the `select` event fires, so nothing downstream needs
// to know about it. `(pi default)` uses the shared
// `PI_DEFAULT_MODEL_SENTINEL` instead, which `setModel` interprets.
const CUSTOM_MODEL_SENTINEL = "__custom__";

export function ModelPicker({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    source?: { $ref: string } | DropdownItem[];
    active?: StringValue;
    placeholder?: StringValue;
    buttonLabel?: StringValue;
    visible?: BooleanValue;
  };
  const visible =
    props.visible === undefined ? true : resolveBoolean(props.visible, state);
  // Custom-id mode: replaces the dropdown with a free-text input so a
  // model not in the loaded registry can still be set as the default.
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");
  if (!visible) return null;

  const sourceRaw = Array.isArray(props.source)
    ? props.source
    : props.source && "$ref" in props.source
      ? resolvePointer(state, props.source.$ref)
      : resolvePointer(state, "/sidebar/models");
  const items = asDropdownItems(sourceRaw);

  // Resolution chain: explicit `props.active` → active tab's model
  // (`/model` mirror) → the user's chosen default for new sessions
  // (`/defaultModel`) → pi default (`/piDefaultModel`, seeded on `ready`).
  // With no agent tab focused, `/model` is absent so the header shows the
  // chosen default rather than pi's boot default.
  const activeTabModel = resolvePointer(state, "/model") as string | undefined;
  const defaultModel = resolvePointer(state, "/defaultModel") as
    | string
    | undefined;
  const piDefaultModel = resolvePointer(state, "/piDefaultModel") as
    | string
    | undefined;
  const activeId = props.active
    ? resolveString(props.active, state)
    : activeTabModel || defaultModel || piDefaultModel || "";

  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "filter models — sonnet, gpt, qwen…";

  if (customMode) {
    const cancel = () => {
      setCustomMode(false);
      setCustomValue("");
    };
    const commit = () => {
      const next = customValue.trim();
      cancel();
      if (next) onEvent("select", { sectionId: "models", itemId: next }, next);
    };
    return (
      <span className="a2ui-model-picker-custom">
        <input
          type="text"
          className="a2ui-model-picker-custom-input"
          placeholder="provider/model-id"
          value={customValue}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Custom model id"
          onChange={(e) => setCustomValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          // Blur cancels — only Enter commits. This also makes Escape's
          // unmount-triggered blur a no-op instead of committing the
          // typed value, and avoids accidental commits on click-away.
          onBlur={cancel}
        />
      </span>
    );
  }

  // Prepend "(pi default)" and append "Custom id…" so the header picker
  // is a full superset of the model controls (no separate Settings field).
  // "(pi default)" is active when no explicit default is set and the
  // visible model is just pi's fallback; in that state no concrete model
  // is marked active too, so the listbox never shows two selected items.
  const piDefaultActive =
    !defaultModel && (!activeTabModel || activeTabModel === piDefaultModel);
  const sectionItems: DropdownItem[] = [
    {
      id: PI_DEFAULT_MODEL_SENTINEL,
      label: "(pi default — picks from env vars)",
      active: piDefaultActive,
    },
    ...items.map((it) => ({
      ...it,
      active: !piDefaultActive && it.id === activeId,
    })),
    { id: CUSTOM_MODEL_SENTINEL, label: "Custom id…" },
  ];
  const activeItem = sectionItems.find((it) => it.active);
  const activeModelItem = items.find((it) => it.id === activeId);
  const thinkingLevels = activeModelItem?.thinkingLevels ?? [];
  const storedThinkingLevel =
    (resolvePointer(state, "/thinkingLevel") as string | undefined) ||
    (resolvePointer(state, "/defaultThinkingLevel") as string | undefined);
  const thinkingLevel =
    storedThinkingLevel && thinkingLevels.includes(storedThinkingLevel)
      ? storedThinkingLevel
      : thinkingLevels[0] || "";
  const codexFastMode = resolvePointer(state, "/codexFastMode") === true;
  const codexFastModeSupported =
    activeModelItem?.codexFastModeSupported === true;

  const buttonLabel = props.buttonLabel
    ? resolveString(props.buttonLabel, state)
    : activeItem?.label || activeId || "model";

  return (
    <span className="a2ui-model-picker-wrap">
      <DropdownPickerCore
        className="a2ui-model-picker"
        buttonLabel={buttonLabel}
        align="right"
        sections={[
          {
            id: "models",
            title: "models",
            items: sectionItems,
            searchable: true,
            searchPlaceholder: placeholder,
            emptyLabel: "no models match",
          },
        ]}
        onSelect={(sectionId, itemId) => {
          if (itemId === CUSTOM_MODEL_SENTINEL) {
            setCustomValue("");
            setCustomMode(true);
            return;
          }
          // PI_DEFAULT_MODEL_SENTINEL flows through unchanged — setModel
          // interprets it as "reset to pi's env-driven default".
          onEvent("select", { sectionId, itemId }, itemId);
        }}
      />
      {thinkingLevels.length > 0 ? (
        <select
          className="a2ui-model-picker-reasoning"
          aria-label="Reasoning level"
          value={thinkingLevel}
          onChange={(e) =>
            onEvent("thinking-level", { level: e.target.value }, e.target.value)
          }
        >
          {thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      ) : null}
      {codexFastModeSupported ? (
        <label
          className="a2ui-model-picker-fast"
          title="Codex Fast mode uses OpenAI's priority service tier and may consume more credits."
        >
          <input
            type="checkbox"
            checked={codexFastMode}
            onChange={(e) =>
              onEvent("codex-fast-mode", { enabled: e.target.checked })
            }
          />
          Fast
        </label>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AppearanceMenu — pulldown that groups Layout + Theme switching into a
// single chrome control. Reads /sidebar/layouts and /sidebar/themes; each
// item fires `select` with `{sectionId, itemId}` so App's sidebar handler
// routes to activateLayoutById / setTheme.
// ---------------------------------------------------------------------------

export function AppearanceMenu({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    layoutsSource?: { $ref: string } | DropdownItem[];
    themesSource?: { $ref: string } | DropdownItem[];
    buttonLabel?: StringValue;
    visible?: BooleanValue;
  };
  const visible =
    props.visible === undefined ? true : resolveBoolean(props.visible, state);
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
// AccountSelector — header dropdown that shows the active auth profile for
// the current tab and lets the user switch between stored accounts. Read
// from `/authProfiles` and the active tab's profile binding. Selecting
// fires `auth_profile_use_for_tab` directly rather than going through the
// sidebar select route, because account switching is a per-tab bridge
// command.
// ---------------------------------------------------------------------------

interface AuthProfileMeta {
  id: string;
  providerId: string;
  label: string;
  kind: string;
}

interface AuthProfileUsageSlim {
  email?: string;
  planType?: string;
  primary?: { usedPercent: number };
}

/** Provider id ("openai-codex") of the active tab's model, for resolving
 *  the provider-default account. */
function activeTabModelProvider(
  state: Record<string, unknown>,
  activeTabId: string,
): string | undefined {
  const tabs = (state.tabs as Array<{ id: string; model?: string }>) ?? [];
  const model = tabs.find((t) => t.id === activeTabId)?.model;
  return typeof model === "string" && model.includes("/")
    ? model.split("/")[0]
    : undefined;
}

/** When exactly one provider default is configured, use it as the global
 *  fallback selection. */
function soleDefault(
  defaultByProvider: Record<string, string> | undefined,
): string | undefined {
  const values = Object.values(defaultByProvider ?? {});
  return values.length === 1 ? values[0] : undefined;
}

export function AccountSelector({
  state,
}: BuiltinComponentProps) {
  const auth = (state.authProfiles ?? {}) as {
    profiles?: AuthProfileMeta[];
    activeByTab?: Record<string, string>;
    defaultByProvider?: Record<string, string>;
    usage?: Record<string, AuthProfileUsageSlim>;
  };
  const profiles = auth.profiles ?? [];
  if (profiles.length === 0) return null;

  const activeTabId =
    typeof state.activeTabId === "string" ? state.activeTabId : "default";

  // Resolve the *effective* account so the chip always reflects which one a
  // prompt would actually use — even before the user explicitly picks one:
  //   tab assignment → provider default → sole default → first profile.
  const tabProvider = activeTabModelProvider(state, activeTabId);
  const resolvedId =
    auth.activeByTab?.[activeTabId] ??
    (tabProvider ? auth.defaultByProvider?.[tabProvider] : undefined) ??
    soleDefault(auth.defaultByProvider) ??
    profiles[0]?.id;
  const activeProfile = profiles.find((p) => p.id === resolvedId);
  const usage = resolvedId ? auth.usage?.[resolvedId] : undefined;

  const buttonLabel = activeProfile
    ? `${activeProfile.label}${usage?.planType ? ` · ${usage.planType}` : ""}`
    : "account";

  const items: DropdownItem[] = profiles.map((p) => {
    const u = auth.usage?.[p.id];
    const hint = [u?.email, u?.planType].filter(Boolean).join(" · ") || p.kind;
    return {
      id: p.id,
      label: p.label,
      hint,
      active: p.id === resolvedId,
    };
  });

  return (
    <DropdownPickerCore
      className="a2ui-account-selector"
      buttonLabel={buttonLabel}
      align="right"
      sections={[
        {
          id: "accounts",
          title: "account",
          items,
          emptyLabel: "no accounts stored",
        },
      ]}
      onSelect={(_sectionId, itemId) => {
        const tabs =
          (state.tabs as
            | { id: string; cwd?: string; model?: string }[]
            | undefined) ?? [];
        const tab = tabs.find((t) => t.id === activeTabId);
        import("../../auth-profiles").then(({ switchAccountForTab }) => {
          void switchAccountForTab(activeTabId, itemId, {
            cwd: tab?.cwd,
            model: tab?.model,
          });
        });
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// VcsStatus — compact header cluster reading the `/vcs` slice: branch (with
// ahead/behind), working-tree change count, PR state, and CI status. PR/CI
// pills open GitHub via the `open-url` event. Hidden gracefully when the
// active root is not a git repo.
// ---------------------------------------------------------------------------

export function VcsStatus({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
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
    <div
      className="ae-vcs-cluster"
      data-loading={vcs.loading ? "true" : undefined}
    >
      {vcs.branch ? (
        <span
          className="ae-vcs-chip ae-vcs-branch"
          title={`On branch ${vcs.branch}`}
        >
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
