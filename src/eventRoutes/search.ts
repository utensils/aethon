import type { EventRouteHandler } from "./types";

/** search-panel renders at App root. Search results land via the
 *  Tauri search_sessions command, not the bridge — events here drive
 *  the overlay's local state.
 *
 *  Routed by `type:search-panel` (registry override key), not id. */
export const handleSearch: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType === "close") {
    ctx.closeSessionSearch();
    return true;
  }
  if (eventType === "query") {
    const value = (data as { value?: string } | undefined)?.value ?? "";
    ctx.setSearchQuery(value);
    return true;
  }
  if (eventType === "scope") {
    const scope = (data as { scope?: "all" | "current" } | undefined)?.scope;
    if (scope === "all" || scope === "current") {
      ctx.setSearchScope(scope);
    }
    return true;
  }
  if (eventType === "select") {
    const hit = (data as
      | {
          hit?: {
            tabId?: string;
            snippetMatch?: string;
          };
        }
      | undefined)?.hit;
    if (hit) ctx.openSearchHit(hit);
    return true;
  }
  return false;
};
