import { useMemo } from "react";
import { dispatchEvent, type EventRouteContext } from "../eventRoutes";
import { useAppEventRouteContext } from "./useAppEventRouteContext";

export function useAppEventRouting(
  options: EventRouteContext,
): (
  component: { id: string; type?: string },
  eventType: string,
  data?: unknown,
) => Promise<boolean> {
  const eventRouteCtx = useAppEventRouteContext(options);

  return useMemo(
    () =>
      (
        component: { id: string; type?: string },
        eventType: string,
        data?: unknown,
      ) =>
        dispatchEvent({ component, eventType, data }, eventRouteCtx),
    [eventRouteCtx],
  );
}
