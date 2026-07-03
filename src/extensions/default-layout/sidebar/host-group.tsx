/**
 * Host group — a first-class node at the TOP of the sidebar hierarchy:
 * host → project → workspace. Each known host renders as a collapsible
 * group header (machine glyph + name + this-mac / remote badge); the
 * active host's group holds the project list (and workspaces nest under
 * those). This is built to stack: when more hosts are paired they each
 * get their own group, and selecting one switches the active host (the
 * same `select` event the old flat `hosts` section emitted, routed by
 * `eventRoutes/sidebar/chrome.ts`).
 *
 * The macOS overlay-titlebar treatment lives separately on the brand
 * strip (`.a2ui-sidebar-title`) — the host bar is pure hierarchy, not
 * window chrome.
 */

import type { ReactNode } from "react";
import type { MouseEvent } from "react";
import { Chevron } from "./chevron";

export interface HostGroupItem {
  id: string;
  label: string;
  hostname?: string;
  fingerprint?: string;
  candidates?: string[];
  paired?: boolean;
  discovered?: boolean;
  /** "this mac" for the local host, otherwise the remote hostname. */
  hint?: string;
  tooltip?: string;
  active: boolean;
}

export interface HostGroupProps {
  host: HostGroupItem;
  /** True when the host row itself owns the current canvas, not merely
   *  the host whose nested projects are visible. */
  selected?: boolean;
  /** Whether the group body (its projects) is shown. Only meaningful for
   *  the active host today; inactive hosts render header-only until
   *  selected. */
  expanded: boolean;
  /** Show the disclosure caret + wire its toggle. Off for inactive hosts
   *  (nothing to collapse yet). */
  collapsible: boolean;
  onToggleExpand: () => void;
  onSelectHost: () => void;
  onPairHost?: (e: MouseEvent<HTMLElement>) => void;
  onHostContextMenu?: (
    e: MouseEvent<HTMLElement>,
    host: HostGroupItem,
  ) => void;
  children?: ReactNode;
}

/** Machine glyph — a monitor outline. Local vs. remote is conveyed by
 *  the badge text, so one icon covers both. */
function HostGlyph() {
  return (
    <svg
      className="ae-host-glyph"
      width="16"
      height="16"
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

export function HostGroup({
  host,
  selected = false,
  expanded,
  collapsible,
  onToggleExpand,
  onSelectHost,
  onPairHost,
  onHostContextMenu,
  children,
}: HostGroupProps) {
  const isLocal = (host.hint ?? "").toLowerCase() === "this mac";
  const canPair = !isLocal && host.paired !== true && host.discovered === true;
  return (
    <div
      className={[
        "ae-host-group",
        host.active ? "ae-host-group--active" : "",
        selected ? "ae-host-group--selected" : "",
        expanded ? "ae-host-group--expanded" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className={[
          "ae-host-group-header",
          selected ? "ae-host-group-header--selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={host.tooltip ?? host.label}
        aria-current={selected ? "page" : undefined}
        onClick={onSelectHost}
        onContextMenu={(e) => onHostContextMenu?.(e, host)}
      >
        {collapsible ? (
          <button
            type="button"
            className={`a2ui-sidebar-item-discl a2ui-sidebar-item-discl-${expanded ? "expanded" : "collapsed"}`}
            aria-label={expanded ? "Collapse host" : "Expand host"}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
          >
            <Chevron expanded={expanded} size={12} />
          </button>
        ) : (
          <span className="a2ui-sidebar-item-discl-spacer" aria-hidden="true" />
        )}
        <span className="ae-host-glyph-wrap" aria-hidden="true">
          <HostGlyph />
        </span>
        <span className="ae-host-name" data-selectable>
          {host.label}
        </span>
        <span
          className={["ae-host-badge", isLocal ? "ae-host-badge--local" : ""]
            .filter(Boolean)
            .join(" ")}
        >
          {isLocal ? "this mac" : (host.hint ?? "remote")}
        </span>
        {canPair ? (
          <button
            type="button"
            className="ae-host-pair-button"
            aria-label={`Pair ${host.label}`}
            onClick={(event) => {
              event.stopPropagation();
              onPairHost?.(event);
            }}
          >
            Pair
          </button>
        ) : null}
      </div>
      {expanded && children ? (
        <div className="ae-host-group-body">{children}</div>
      ) : null}
    </div>
  );
}
