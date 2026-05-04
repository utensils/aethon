/** Event route table. Maps each renderer-side event to a handler.
 *  Adding a new route:
 *
 *    1. Create `eventRoutes/<name>.ts` exporting an `EventRouteHandler`.
 *    2. Register it under the appropriate prefix key(s) in
 *       BUILTIN_ROUTE_TABLE below.
 *    3. Add a happy-path test in `eventRoutes/<name>.test.ts`.
 *
 *  Three precedence layers, enforced by `dispatchEvent`:
 *
 *    1. **Shell-consent reserved prefixes** — security boundary. A
 *       user's Allow / Deny / dismiss on a shell-write / shell-close
 *       / session-delete prompt MUST resolve before any extension
 *       matcher sees the event.
 *    2. **Extension event routes** — when an extension has registered
 *       a route that matches this event, the dispatcher returns
 *       `false` (renderer forwards to bridge → extension's
 *       `aethon.onEvent` handler runs), skipping built-ins.
 *    3. **Built-in routes** — keyed by `id:<componentId>` and
 *       `type:<componentType>`; each handler returns `true` if it
 *       matched and handled.
 *
 *  See `dispatchEvent.test.ts` for the precedence contract test. */
import type {
  EventRouteContext,
  EventRouteEvent,
  EventRouteHandler,
} from "./types";
import { handleShellConsent } from "./shellConsent";
import { matchesExtensionRoute } from "./extensions";
import { handleChatInput } from "./chatInput";
import { handleSettings } from "./settings";
import { handleSearch } from "./search";
import { handlePalette } from "./palette";
import { handleNotifications } from "./notifications";
import { handleTerminalPanel, handleShareModeCycle } from "./terminal";
import { handleTabStrip, handleEmptyState } from "./tabStrip";
import {
  handleSidebarResize,
  handleSidebarResizeEnd,
  handleSidebarRemoveProject,
  handleSidebarDeleteSession,
  handleSectionedSelect,
} from "./sidebar";

/** Lookup table for built-in routes. Keys are `id:<componentId>` or
 *  `type:<componentType>`. The dispatcher computes both keys for an
 *  event and concatenates the matched handler lists. Order within a
 *  list is the order of declaration here. */
export const BUILTIN_ROUTE_TABLE: ReadonlyMap<string, readonly EventRouteHandler[]> =
  new Map<string, readonly EventRouteHandler[]>([
    // notification-stack: `handleShellConsent` is run separately as the
    // top-precedence gate; the general handler runs here.
    ["id:notification-stack", [handleNotifications]],
    ["id:settings-panel", [handleSettings]],
    ["id:search-panel", [handleSearch]],
    ["id:command-palette", [handlePalette]],
    ["id:chat-input", [handleChatInput]],
    ["id:empty-state", [handleEmptyState]],
    ["id:sidebar", [
      handleSidebarResize,
      handleSidebarResizeEnd,
      handleSidebarRemoveProject,
      handleSidebarDeleteSession,
      handleSectionedSelect,
    ]],
    ["id:model-picker", [handleSectionedSelect]],
    ["id:appearance-menu", [handleSectionedSelect]],
    ["type:terminal-panel", [handleTerminalPanel]],
    ["type:tab-strip", [handleTabStrip]],
    ["type:shell-canvas", [handleShareModeCycle]],
    ["type:share-mode-badge", [handleShareModeCycle]],
  ]);

/** Dispatch a renderer-side event through the precedence layers.
 *  Returns true when a handler claimed the event (renderer suppresses
 *  its default forward); false when no handler claimed it OR an
 *  extension route matched (renderer forwards to bridge). */
export async function dispatchEvent(
  event: EventRouteEvent,
  ctx: EventRouteContext,
): Promise<boolean> {
  // Layer 1: shell-consent reserved prefixes.
  if (await handleShellConsent(event, ctx)) return true;

  // Layer 2: extension-route interception. When matched the renderer
  // forwards to the bridge so the extension's matcher fires; built-ins
  // are skipped entirely.
  if (matchesExtensionRoute(event, ctx)) return false;

  // Layer 3: built-ins. Look up handlers by id-key then type-key; first
  // handler to return true wins.
  const idKey = `id:${event.component.id}`;
  const handlers: EventRouteHandler[] = [];
  const idHandlers = BUILTIN_ROUTE_TABLE.get(idKey);
  if (idHandlers) handlers.push(...idHandlers);
  if (event.component.type) {
    const typeHandlers = BUILTIN_ROUTE_TABLE.get(
      `type:${event.component.type}`,
    );
    if (typeHandlers) handlers.push(...typeHandlers);
  }
  for (const handler of handlers) {
    if (await handler(event, ctx)) return true;
  }
  return false;
}

export type {
  EventRouteContext,
  EventRouteEvent,
  EventRouteHandler,
} from "./types";
