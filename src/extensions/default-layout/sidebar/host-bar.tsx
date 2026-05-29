/**
 * Host identity bar — the top strip of the sidebar and the visible root
 * of the host → project → worktree hierarchy. Replaces the old plain
 * wordmark title row.
 *
 * On macOS the whole strip is a `data-tauri-drag-region` (the window has
 * an overlay titlebar, so there's no native bar to grab) with left
 * padding that clears the floating traffic lights — see the
 * `[data-platform="mac"]` rules in chrome.css. The interactive host chip
 * opts back out of dragging via the global `-webkit-app-region: no-drag`
 * reset.
 *
 * When more than one host is known the chip becomes a switcher: clicking
 * opens a small menu that emits the same `select` event the old `hosts`
 * sidebar section used (`{ sectionId: "hosts", itemId }`), routed by
 * `eventRoutes/sidebar/chrome.ts`.
 */

import { useEffect, useRef, useState } from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { AeMarkInline } from "../layout";

export interface HostBarItem {
  id: string;
  label: string;
  /** "this mac" for the local host, otherwise the remote hostname. */
  hint?: string;
  tooltip?: string;
  active: boolean;
}

export interface HostBarProps {
  hosts: HostBarItem[];
  version?: string;
  onEvent: BuiltinComponentProps["onEvent"];
}

/** Small machine glyph — a monitor outline. Local vs. remote is conveyed
 *  by the badge text, not the glyph, so one icon covers both. */
function HostGlyph() {
  return (
    <svg
      className="ae-hostbar-glyph"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5" />
      <path d="M5.5 13.5h5M8 11v2.5" />
    </svg>
  );
}

export function HostBar({ hosts, version, onEvent }: HostBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const active = hosts.find((h) => h.active) ?? hosts[0] ?? null;
  const hasSwitcher = hosts.length > 1;
  const isLocal = (h: HostBarItem | null) =>
    !!h && (h.hint ?? "").toLowerCase() === "this mac";

  // Dismiss the switcher on any outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const selectHost = (id: string) => {
    setMenuOpen(false);
    onEvent("select", { sectionId: "hosts", itemId: id }, id);
  };

  return (
    <div className="a2ui-sidebar-hostbar" data-tauri-drag-region ref={rootRef}>
      <button
        type="button"
        className={[
          "ae-hostbar-chip",
          hasSwitcher ? "ae-hostbar-chip--switcher" : "",
          menuOpen ? "ae-hostbar-chip--open" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={active?.tooltip ?? active?.label}
        aria-haspopup={hasSwitcher ? "menu" : undefined}
        aria-expanded={hasSwitcher ? menuOpen : undefined}
        disabled={!active}
        onClick={() => {
          if (!active) return;
          if (hasSwitcher) setMenuOpen((v) => !v);
        }}
      >
        <span className="ae-hostbar-glyph-wrap" aria-hidden="true">
          <HostGlyph />
        </span>
        <span className="ae-hostbar-name" data-selectable>
          {active?.label ?? "no host"}
        </span>
        {active && (
          <span
            className={[
              "ae-hostbar-badge",
              isLocal(active) ? "ae-hostbar-badge--local" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {isLocal(active) ? "this mac" : (active.hint ?? "remote")}
          </span>
        )}
        {hasSwitcher && (
          <svg
            className="ae-hostbar-caret"
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M2.5 4.5L6 8L9.5 4.5" />
          </svg>
        )}
      </button>

      <span className="ae-hostbar-brand" aria-hidden="true">
        <AeMarkInline size={18} radius={4} />
        {version && <span className="ae-hostbar-version">{version}</span>}
      </span>

      {hasSwitcher && menuOpen && (
        <ul className="ae-hostbar-menu" role="menu">
          {hosts.map((h) => (
            <li key={h.id} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={h.active}
                className={[
                  "ae-hostbar-menu-item",
                  h.active ? "ae-hostbar-menu-item--active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                title={h.tooltip ?? h.label}
                onClick={() => selectHost(h.id)}
              >
                <span className="ae-hostbar-menu-glyph" aria-hidden="true">
                  <HostGlyph />
                </span>
                <span className="ae-hostbar-menu-name">{h.label}</span>
                <span className="ae-hostbar-menu-hint">
                  {isLocal(h) ? "this mac" : (h.hint ?? "remote")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
