import { useCallback, useEffect, useRef, useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { resolveVisibility } from "../../utils/visibilityResolver";
import type { ToolCallsMode, VisibilityMode } from "../../config";
import type { Tab } from "../../types/tab";
import { readUiScale } from "./layout";

/**
 * Composer-bar visibility pills (chrome composite). Two pills — Thinking and
 * Tool calls — toggle the active session's transcript visibility on click.
 * Thinking is on/off; tool calls are either shown as lightweight activity rows
 * or collapsed into one quiet turn summary.
 * A "More options" caret opens a popover that explains scope (this session vs.
 * all sessions), offers a reset, and the per-session project-root guardrail.
 *
 * Routing: events are keyed by `type:composer-visibility-pills` in
 * BUILTIN_ROUTE_TABLE (see `eventRoutes/composerPills.ts`). The pill reads
 * effective visibility via the shared resolver so it shows the same value the
 * transcript renders.
 */

const THINKING_LABEL: Record<VisibilityMode, string> = {
  show: "on",
  collapse: "off",
  hide: "off",
};

const THINKING_TITLE: Record<VisibilityMode, string> = {
  show: "on",
  collapse: "off",
  hide: "off",
};

const TOOL_LABEL: Record<ToolCallsMode, string> = {
  show: "shown",
  "group-turn": "collapsed",
  "group-run": "collapsed",
  "group-block": "collapsed",
  hide: "collapsed",
};

const TOOL_TITLE: Record<ToolCallsMode, string> = {
  show: "shown as activity rows",
  "group-turn": "collapsed into turn summaries",
  "group-run": "collapsed into turn summaries",
  "group-block": "collapsed into turn summaries",
  hide: "collapsed into turn summaries",
};

/** Effective hard-guardrail state: per-tab override wins; else the global
 *  default mirrored at `/guardrails/hardEnforceProjectRoot`; else false. */
function resolveHardEnforce(
  state: Record<string, unknown>,
  tabId: string | undefined,
): boolean {
  const tab = findTab(state, tabId);
  if (typeof tab?.hardEnforceProjectRoot === "boolean") {
    return tab.hardEnforceProjectRoot;
  }
  const global = state.guardrails as
    | { hardEnforceProjectRoot?: unknown }
    | undefined;
  return global?.hardEnforceProjectRoot === true;
}

function findTab(
  state: Record<string, unknown>,
  tabId: string | undefined,
): Tab | undefined {
  const tabs = state.tabs;
  return tabId && Array.isArray(tabs)
    ? (tabs as Tab[]).find((t) => t?.id === tabId)
    : undefined;
}

/** Whether a category currently carries an explicit per-session override
 *  (distinct from following the global default). Drives the "session" marker. */
function hasOverride(
  state: Record<string, unknown>,
  tabId: string | undefined,
  category: "thinking" | "toolCalls",
): boolean {
  const ov = findTab(state, tabId)?.visibilityOverrides;
  const v = ov?.[category];
  return v !== undefined && v !== null;
}

export function ComposerVisibilityPills({
  state,
  tabId,
  onEvent,
}: BuiltinComponentProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [coords, setCoords] = useState<{
    bottom: number;
    right: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const visibility = resolveVisibility(state, tabId);
  const hardEnforce = resolveHardEnforce(state, tabId);
  const activeTab = findTab(state, tabId);
  const planMode =
    activeTab?.kind === "agent"
      ? activeTab.planMode === true
      : state.planMode === true;
  const sessionOverridden =
    hasOverride(state, tabId, "thinking") ||
    hasOverride(state, tabId, "toolCalls");

  const close = useCallback(() => {
    setMenuOpen(false);
    setCoords(null);
  }, []);

  // The pills live inside `.a2ui-layout-cell`, which clips overflow. Render the
  // popover with position:fixed and coordinates from the trigger's bounding
  // rect (converted out of the UI-scale transform) so it floats *above* the
  // composer uncut — the same trick DropdownPickerCore uses.
  const openMenu = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) {
      const scale = readUiScale();
      setCoords({
        bottom: (window.innerHeight - r.top) / scale + 6,
        right: (window.innerWidth - r.right) / scale,
      });
    }
    setMenuOpen(true);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onResize = () => close();
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen, close]);

  const pill = (category: "thinking" | "toolCalls", label: string) => {
    const mode = visibility[category];
    const stateLabel =
      category === "thinking"
        ? THINKING_LABEL[visibility.thinking]
        : TOOL_LABEL[visibility.toolCalls];
    const titleText =
      category === "thinking"
        ? THINKING_TITLE[visibility.thinking]
        : TOOL_TITLE[visibility.toolCalls];
    const scoped = hasOverride(state, tabId, category);
    return (
      <button
        type="button"
        className="ae-vis-pill"
        data-category={category}
        data-mode={mode}
        data-scope={scoped ? "session" : "global"}
        title={`${label}: ${titleText}${
          scoped ? " — this session only (overrides the global default)" : ""
        }. Click to toggle.`}
        aria-label={`${label} visibility: ${stateLabel}${
          scoped ? ", this session" : ""
        }. Click to toggle.`}
        onClick={() => onEvent("cycle", { category })}
      >
        <span className="ae-vis-pill-dot" aria-hidden="true" />
        <span className="ae-vis-pill-label">{label}</span>
        <span className="ae-vis-pill-state">{stateLabel}</span>
        {scoped && (
          <span className="ae-vis-pill-scope" aria-hidden="true">
            session
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="ae-composer-pills">
      <button
        type="button"
        className="ae-vis-pill ae-plan-pill"
        data-mode={planMode ? "on" : "off"}
        title={`Plan mode is ${planMode ? "on" : "off"}. Click or press Shift+Tab to toggle.`}
        aria-label={`Plan mode: ${planMode ? "on" : "off"}. Click to toggle.`}
        aria-pressed={planMode}
        onClick={() => onEvent("toggle-plan")}
      >
        <span className="ae-vis-pill-dot" aria-hidden="true" />
        <span className="ae-vis-pill-label">Plan mode</span>
        <span className="ae-vis-pill-state">{planMode ? "on" : "off"}</span>
      </button>
      {pill("thinking", "Thinking")}
      {pill("toolCalls", "Tool calls")}
      <div className="ae-vis-more">
        <button
          ref={triggerRef}
          type="button"
          className="ae-vis-more-btn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="More options"
          aria-label="More visibility options"
          onClick={() => (menuOpen ? close() : openMenu())}
        >
          …
        </button>
        {menuOpen && coords && (
          <>
            <div className="ae-vis-menu-backdrop" onClick={close} />
            <div
              className="ae-vis-menu"
              role="menu"
              style={{ bottom: coords.bottom, right: coords.right }}
            >
              <div className="ae-vis-menu-head">This session</div>
              <button
                type="button"
                role="menuitem"
                className="ae-vis-menu-item"
                onClick={() => {
                  onEvent("set-default");
                  close();
                }}
              >
                Save current visibility as default for all sessions
              </button>
              {sessionOverridden && (
                <button
                  type="button"
                  role="menuitem"
                  className="ae-vis-menu-item"
                  onClick={() => {
                    onEvent("reset-to-global");
                    close();
                  }}
                >
                  Reset this session to the global default
                </button>
              )}
              <div className="ae-vis-menu-sep" role="separator" />
              <div className="ae-vis-menu-head">Tools</div>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={hardEnforce}
                className="ae-vis-menu-item ae-vis-menu-toggle"
                data-checked={hardEnforce ? "true" : "false"}
                onClick={() => {
                  onEvent("toggle-guardrail", { next: !hardEnforce });
                  close();
                }}
              >
                <span className="ae-vis-menu-check" aria-hidden="true">
                  {hardEnforce ? "✓" : ""}
                </span>
                Restrict tools to project root (this session)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
