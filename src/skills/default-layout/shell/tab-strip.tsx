/**
 * TabStrip — horizontal row of tab pills + a "+" button to create new ones.
 * Each tab shows its label; the active one is highlighted; non-default tabs
 * have a small "×" close button. All interactions go through onEvent so
 * App.tsx can route them to its tab helpers (newTab / closeTab / switch).
 *
 * Props:
 *   tabs:        $ref to /tabs (array of { id, label }) — items to render
 *   activeId:    $ref to /activeTabId — which tab is highlighted
 *
 * Events:
 *   ("select",  { tabId })  click on a tab pill
 *   ("close",   { tabId })  click on a tab's close button
 *   ("new")                 click on the "+" button
 */

import { useMemo } from "react";
import type { StringValue } from "../../../types/a2ui";
import { resolveString } from "../../../utils/dataBinding";
import { resolvePointer } from "../../../utils/jsonPointer";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";

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
