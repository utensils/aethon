import { useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { resolveVisibility } from "../../utils/visibilityResolver";
import type { VisibilityMode } from "../../config";

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

export function ComposerVisibilityPills({
  state,
  tabId,
  onEvent,
}: BuiltinComponentProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const visibility = resolveVisibility(state, tabId);

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
                role="menuitem"
                className="ae-vis-menu-item"
                onClick={() => {
                  onEvent("set-default");
                  setMenuOpen(false);
                }}
              >
                Use current as default for all sessions
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
