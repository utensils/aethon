import { useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { resolveVisibility } from "../../utils/visibilityResolver";
import type { VisibilityMode } from "../../config";
import type { Tab } from "../../types/tab";

/**
 * Composer-bar tri-state visibility pills (chrome composite). Two pills —
 * Thinking and Tool calls — each cycle show → collapse → hide on click,
 * driving the active session's transcript. A "…" caret promotes the current
 * choices to the global default for all sessions.
 *
 * Routing: events are keyed by `type:composer-visibility-pills` in
 * BUILTIN_ROUTE_TABLE (see `eventRoutes/composerPills.ts`). The pill reads
 * effective visibility via the shared resolver so it shows the same value the
 * transcript renders.
 */

const MODE_LABEL: Record<VisibilityMode, string> = {
  show: "shown",
  collapse: "collapsed",
  hide: "hidden",
};

const MODE_TITLE: Record<VisibilityMode, string> = {
  show: "shown in full",
  collapse: "collapsed / grouped",
  hide: "hidden",
};

/** Effective hard-guardrail state: per-tab override wins; else the global
 *  default mirrored at `/guardrails/hardEnforceProjectRoot`; else false. */
function resolveHardEnforce(
  state: Record<string, unknown>,
  tabId: string | undefined,
): boolean {
  const tabs = state.tabs;
  const tab =
    tabId && Array.isArray(tabs)
      ? (tabs as Tab[]).find((t) => t?.id === tabId)
      : undefined;
  if (typeof tab?.hardEnforceProjectRoot === "boolean") {
    return tab.hardEnforceProjectRoot;
  }
  const global = state.guardrails as
    | { hardEnforceProjectRoot?: unknown }
    | undefined;
  return global?.hardEnforceProjectRoot === true;
}

export function ComposerVisibilityPills({
  state,
  tabId,
  onEvent,
}: BuiltinComponentProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const visibility = resolveVisibility(state, tabId);
  const hardEnforce = resolveHardEnforce(state, tabId);

  const pill = (category: "thinking" | "toolCalls", label: string) => {
    const mode = visibility[category];
    return (
      <button
        type="button"
        className="ae-vis-pill"
        data-category={category}
        data-mode={mode}
        title={`${label}: ${MODE_TITLE[mode]} — click to cycle (show → collapse → hide)`}
        aria-label={`${label} visibility: ${MODE_LABEL[mode]}. Click to cycle.`}
        onClick={() => onEvent("cycle", { category })}
      >
        <span className="ae-vis-pill-dot" aria-hidden="true" />
        <span className="ae-vis-pill-label">{label}</span>
        <span className="ae-vis-pill-state">{MODE_LABEL[mode]}</span>
      </button>
    );
  };

  return (
    <div className="ae-composer-pills">
      {pill("thinking", "Thinking")}
      {pill("toolCalls", "Tool calls")}
      <div className="ae-vis-more">
        <button
          type="button"
          className="ae-vis-more-btn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Visibility scope"
          aria-label="Visibility scope menu"
          onClick={() => setMenuOpen((v) => !v)}
        >
          …
        </button>
        {menuOpen && (
          <>
            <div
              className="ae-vis-menu-backdrop"
              onClick={() => setMenuOpen(false)}
            />
            <div className="ae-vis-menu" role="menu">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={hardEnforce}
                className="ae-vis-menu-item ae-vis-menu-toggle"
                data-checked={hardEnforce ? "true" : "false"}
                onClick={() => {
                  onEvent("toggle-guardrail", { next: !hardEnforce });
                  setMenuOpen(false);
                }}
              >
                <span className="ae-vis-menu-check" aria-hidden="true">
                  {hardEnforce ? "✓" : ""}
                </span>
                Restrict tools to project root (this session)
              </button>
              <div className="ae-vis-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="ae-vis-menu-item"
                onClick={() => {
                  onEvent("set-default");
                  setMenuOpen(false);
                }}
              >
                Use current visibility as default for all sessions
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
