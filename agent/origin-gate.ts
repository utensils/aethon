/**
 * Worker-origin stamping for frontend-registry messages.
 *
 * The frontend keeps ONE set of extension registries (components, themes,
 * slash commands, keybindings, menu items, layouts, event routes, frontend
 * modules, highlight grammars) plus the active layout. Every bridge process
 * — the global bridge and each per-tab worker — sends these as wholesale
 * replacements derived from its own local state. Applied blindly, a worker
 * spawned for a background project replaces the active project's surface
 * with its own (the multi-workspace "extension clobber" bug).
 *
 * Fix: workers stamp these messages with `originTabId` so the frontend can
 * gate them — apply only when the origin tab is part of the active
 * workspace (its bucket is the one mirrored to `/tabs`), otherwise ack
 * `ok:false`. Messages from the global bridge stay unstamped and are always
 * authoritative. This keeps agent-driven UI mutation working from the
 * active tab's worker while making background workers unable to clobber.
 */

export type SendFn = (obj: Record<string, unknown>) => void;

/** Bridge → frontend message types that replace a frontend-global registry
 *  (or the layout) wholesale. Keep in sync with the senders in
 *  aethon-api.ts, keybindings.ts, event-routes.ts, layout-manager.ts and
 *  projectLifecycle.ts. */
export const FRONTEND_REGISTRY_TYPES: ReadonlySet<string> = new Set([
  "extension_components",
  "extension_themes",
  "extension_slash_commands",
  "extension_keybindings",
  "extension_menu_items",
  "extension_layouts",
  "extension_event_routes",
  "extension_frontend_modules",
  "extension_highlight_grammars",
  "register_highlight_grammar",
  "layout_set",
  "layout_patch",
]);

/** Wrap a send fn so registry-replacing messages carry the worker's tab id
 *  as `originTabId`. All other messages pass through untouched. */
export function withWorkerOrigin(send: SendFn, workerTabId: string): SendFn {
  return (obj) => {
    const type = obj["type"];
    if (typeof type === "string" && FRONTEND_REGISTRY_TYPES.has(type)) {
      send({ ...obj, originTabId: workerTabId });
      return;
    }
    send(obj);
  };
}
