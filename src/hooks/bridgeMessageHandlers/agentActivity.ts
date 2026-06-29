import type { BridgeMessageContext, BridgeMessageHandler } from "./types";

interface IncomingActivity {
  label: string;
  detail: string;
}

function readActivity(value: unknown): IncomingActivity | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.label !== "string" || typeof raw.detail !== "string") {
    return null;
  }
  return {
    label: raw.label,
    detail: raw.detail,
  };
}

export function clearAgentActivity(
  ctx: BridgeMessageContext,
  tabId: string,
): void {
  const currentMap = ctx.stateRef.current.agentActivityByTab as
    | Record<string, unknown>
    | undefined;
  if (!currentMap?.[tabId]) return;
  ctx.setState((prev) => {
    const map = prev.agentActivityByTab as
      | Record<string, unknown>
      | undefined;
    if (!map || !map[tabId]) return prev;
    const next = { ...map };
    delete next[tabId];
    return { ...prev, agentActivityByTab: next };
  });
}

export const handleAgentActivity: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  if (data.clear === true) {
    clearAgentActivity(ctx, tabId);
    return;
  }
  const activity = readActivity(data.activity);
  if (!activity) return;
  const now = Date.now();
  ctx.setState((prev) => {
    const map =
      (prev.agentActivityByTab as
        | Record<string, { startedAt?: unknown }>
        | undefined) ?? {};
    const startedAt =
      typeof map[tabId]?.startedAt === "number" ? map[tabId].startedAt : now;
    return {
      ...prev,
      agentActivityByTab: {
        ...map,
        [tabId]: {
          ...activity,
          startedAt,
          updatedAt: now,
        },
      },
    };
  });
};
