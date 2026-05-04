import type { EventRouteContext, EventRouteEvent } from "./types";

/** Returns true when an extension has registered an event-route that
 *  matches this event (componentId + eventType, with both wildcards
 *  permitted). Handled separately from the route table because a
 *  match's effect is "skip built-ins, forward to bridge" rather than
 *  "handled, suppress forward" — the dispatcher consults this gate
 *  between shell-consent and built-ins. */
export function matchesExtensionRoute(
  event: EventRouteEvent,
  ctx: EventRouteContext,
): boolean {
  // "extension" mode: extensions have taken over routing entirely. The
  // dispatcher returns false (forward to bridge) for every event.
  if (ctx.extensionEventRoutingModeRef.current === "extension") return true;

  const routes = ctx.extensionEventRoutesRef.current;
  if (routes.length === 0) return false;
  return routes.some((r) => {
    const cidOk = !r.componentId || r.componentId === event.component.id;
    const evtOk = !r.eventType || r.eventType === event.eventType;
    return cidOk && evtOk;
  });
}
