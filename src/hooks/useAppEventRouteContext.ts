import { useState } from "react";
import type { EventRouteContext } from "../eventRoutes";

export function useAppEventRouteContext(
  options: EventRouteContext,
): EventRouteContext {
  const [eventRouteContext] = useState<EventRouteContext>(() => options);
  return eventRouteContext;
}
