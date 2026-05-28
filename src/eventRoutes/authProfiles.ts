import type { EventRouteHandler } from "./types";

export const handleAuthProfiles: EventRouteHandler = ({ eventType }, ctx) => {
  if (eventType !== "close") return false;
  ctx.setState((prev) => ({
    ...prev,
    authProfiles: {
      profiles: [],
      defaultByProvider: {},
      providers: [],
      activeByTab: {},
      ...(prev.authProfiles ?? {}),
      modal: { open: false },
    },
  }));
  return true;
};
