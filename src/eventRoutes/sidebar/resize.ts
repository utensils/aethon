import type { EventRouteHandler } from "../types";
import { WORKSTATION_AREAS } from "../../hooks/useFocus";

/** sidebar resize: live drag updates the leading column token in
 *  /layout/columns. Layouts shape grid columns as either
 *  "${SIDEBAR}px minmax(0,1fr)" or
 *  "${SIDEBAR}px minmax(0,1fr) ${INSPECTOR}px" — replace just the first
 *  token so non-sidebar columns survive the rewrite.
 *
 *  All sidebar handlers are routed by `type:sidebar` (registry override
 *  key) so a custom layout that renames the sidebar instance still
 *  receives these events — only the eventType filters apply. */
export const handleSidebarResize: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "resize") return false;
  const next = (data as { width?: number } | undefined)?.width;
  if (typeof next === "number") {
    ctx.setState((prev) => {
      const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
      const current =
        (layout.columns as string | undefined) ?? "320px minmax(0,1fr)";
      const tokens = current.trim().split(/\s+/);
      tokens[0] = `${next}px`;
      // Stash the new left width on the layout so a hide/show
      // round-trip restores the user's sized sidebar instead of the
      // boot default. The files sidebar carries its own memo via the
      // toggle helpers.
      return {
        ...prev,
        layout: {
          ...layout,
          columns: tokens.join(" "),
          areas: WORKSTATION_AREAS,
          lastLeftWidth: `${next}px`,
        },
      };
    });
  }
  return true;
};

/** sidebar resize-end: handled for drag lifecycle symmetry. The app-wide
 *  session UI snapshot persists the final /layout/columns value. */
export const handleSidebarResizeEnd: EventRouteHandler = ({ eventType }) => {
  if (eventType !== "resize-end") return false;
  return true;
};
