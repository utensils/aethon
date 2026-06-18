import type { EventRouteHandler } from "./types";

export const handleScheduledTasks: EventRouteHandler = ({ eventType }, ctx) => {
  if (eventType !== "close") return false;
  ctx.setState((prev) => ({
    ...prev,
    scheduledTasks: {
      ...(prev.scheduledTasks ?? {}),
      open: false,
    },
  }));
  return true;
};
