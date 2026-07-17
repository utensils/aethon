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
import { useDismissibleLayer } from "./use-dismissible-layer";
import type { BooleanValue, StringValue } from "../../types/a2ui";
import { resolveBoolean, resolveString } from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import { PI_DEFAULT_MODEL_SENTINEL } from "../../utils/modelPicker";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import type { Tab } from "../../types/tab";
import {
  accountsForProvider,
  providerOfModelId,
  resolveSelectableProfileId,
  soleDefaultProfileId,
} from "../../auth-profiles/selection";
import { modelForNewProjectTab } from "../../hooks/tabOps/helpers";
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
      const viewportGutter = 8;
      const availableWidth = Math.max(0, viewportWidth - viewportGutter * 2);
      const minimumPanelWidth = Math.min(120, availableWidth);
      const panelWidth = Math.max(
        minimumPanelWidth,
        Math.min(Math.max(triggerWidth, 240), availableWidth),
      );
      const desiredLeft =
        align === "right" ? r.right / scale - panelWidth : r.left / scale;
      const maxLeft = Math.max(
        viewportGutter,
        viewportWidth - panelWidth - viewportGutter,
      );
      setCoords({
        top: Math.min(
          r.bottom / scale + 6,
          Math.max(viewportGutter, viewportHeight - viewportGutter),
        ),
        left: Math.max(viewportGutter, Math.min(desiredLeft, maxLeft)),
        width: panelWidth,
      });
    }
    setOpen(true);
  };

  useDismissibleLayer({
    active: open,
    onDismiss: close,
    insideRefs: [rootRef, panelRef],
    dismissOnPointerOutside: true,
    dismissOnResize: true,
  });

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
          left: coords.left,
          width: coords.width,
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
              {reasoningLevelLabel(level)}
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

function reasoningLevelLabel(level: string): string {
  switch (level) {
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Light";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    case "ultra":
      return "Ultra";
    default:
      return level;
  }
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
  return providerOfModelId(tabs.find((t) => t.id === activeTabId)?.model);
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
  const activeTab = (
    (state.tabs as Array<{
      id: string;
      model?: string;
      authProfileId?: string;
      kind?: string;
    }>) ?? []
  ).find((t) => t.id === activeTabId);
  // An active *agent* tab has a live session to rebind; the overview (or a
  // shell/editor tab) does not — there a pick sets the provider default that
  // new tasks inherit instead.
  const isAgentTab = !!activeTab && (activeTab.kind ?? "agent") === "agent";

  // Provider scoping. An agent tab scopes to its own model's provider.
  // Otherwise (overview) scope to the provider of the model a task launched
  // from here would actually boot with — `modelForNewProjectTab` folds in
  // `/defaultModel`, per-project memory (`projectModels`), and the pi default
  // in the same precedence the new tab uses — so the selector reflects and its
  // `setDefaultAccount` targets the provider new work will run as.
  const activeProjectId =
    typeof state.activeProjectId === "string" ? state.activeProjectId : null;
  const piDefaultModel =
    typeof state.piDefaultModel === "string" ? state.piDefaultModel : "";
  const newTabModel = modelForNewProjectTab(
    state,
    activeProjectId,
    piDefaultModel,
  );
  const provider = isAgentTab
    ? activeTabModelProvider(state, activeTabId)
    : providerOfModelId(newTabModel);

  // Only offer accounts for that provider — switching to a profile from
  // another provider would point auth at a provider that can't back the
  // model. When the provider is unknown, fall back to all profiles.
  const selectable = accountsForProvider(profiles, provider);
  if (selectable.length === 0) return null;

  // Resolve the *effective* account so the chip always reflects which one a
  // prompt would actually use — even before the user explicitly picks one.
  // For an agent tab the tab mirror updates immediately on
  // auth_profile_changed (snapshot can lag), so prefer it. For the overview
  // the source of truth is the provider default (set via auth_profile_set_default).
  const resolvedId = isAgentTab
    ? resolveSelectableProfileId(
        selectable,
        activeTab?.authProfileId,
        auth.activeByTab?.[activeTabId],
        provider ? auth.defaultByProvider?.[provider] : undefined,
        soleDefaultProfileId(auth.defaultByProvider),
      )
    : resolveSelectableProfileId(
        selectable,
        provider ? auth.defaultByProvider?.[provider] : undefined,
        soleDefaultProfileId(auth.defaultByProvider),
      );
  const activeProfile = selectable.find((p) => p.id === resolvedId);
  const usage = resolvedId ? auth.usage?.[resolvedId] : undefined;

  const buttonLabel = activeProfile
    ? `${activeProfile.label}${usage?.planType ? ` · ${usage.planType}` : ""}`
    : "account";

  const items: DropdownItem[] = selectable.map((p) => {
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
        import("../../auth-profiles").then(
          ({
            resolveAccountSwitchTarget,
            switchAccountForTab,
            setDefaultAccount,
          }) => {
            // No live agent session (overview / shell / editor): the pick sets
            // the provider default that new tasks inherit, rather than binding
            // a phantom "default" session whose change the header never shows.
            if (!isAgentTab) {
              void setDefaultAccount(itemId);
              return;
            }
            const target = resolveAccountSwitchTarget(
              (state.tabs as Tab[] | undefined) ?? [],
              activeTabId,
            );
            // Don't switch mid-prompt — the global + worker auth states would
            // diverge (UI shows the new account, worker keeps the old creds).
            if (target.busy) return;
            void switchAccountForTab(target.tabId, itemId, {
              cwd: target.cwd,
              model: target.model,
            });
          },
        );
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

  // Clicking the "N changed" chip opens every listed changed file in editor
  // tabs. Paths from git_file_status are relative to the root.
  const vcsRoot = vcs.root;
  const changedFileTargets = vcsRoot
    ? vcs.changes.files.map((file) => ({
        filePath: absolutePathFor(vcsRoot, file.path),
        rootPath: vcsRoot,
      }))
    : [];
  const openChanged = () => {
    if (!vcs.root || changedFileTargets.length === 0) return;
    onEvent("file-tree-open-many", { files: changedFileTargets });
  };
  const changeTitle =
    changeTotal === 1 && vcs.changes.files[0]
      ? `${vcs.changes.files[0].path} — open in editor`
      : `${changeTotal} changed files — open all in editor`;

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
          disabled={changedFileTargets.length === 0}
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
