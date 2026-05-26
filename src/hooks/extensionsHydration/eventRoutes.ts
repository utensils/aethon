import type { MutableRefObject } from "react";

export interface EventRoutesDeps {
  extensionEventRoutesRef: MutableRefObject<
    { componentId?: string; eventType?: string }[]
  >;
  extensionEventRoutingModeRef: MutableRefObject<"builtin" | "extension">;
}

export function useHydrateEventRoutes(deps: EventRoutesDeps) {
  const { extensionEventRoutesRef, extensionEventRoutingModeRef } = deps;
  return function hydrateEventRoutes(
    routes: { componentId?: string; eventType?: string }[],
    mode: "builtin" | "extension" = extensionEventRoutingModeRef.current,
  ) {
    extensionEventRoutesRef.current = routes;
    extensionEventRoutingModeRef.current = mode;
  };
}
