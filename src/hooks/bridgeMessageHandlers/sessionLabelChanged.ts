import { applyOptimisticTabLabel } from "../../eventRoutes/sessionRename";
import type {
  BridgeMessage,
  BridgeMessageHandler,
  DiscoveredSession,
} from "./types";

function discoveredSessionFromMessage(
  value: unknown,
): DiscoveredSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.tabId !== "string" ||
    typeof record.lastModified !== "number"
  ) {
    return null;
  }
  return {
    tabId: record.tabId,
    lastModified: record.lastModified,
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(typeof record.firstUserMessage === "string"
      ? { firstUserMessage: record.firstUserMessage }
      : {}),
    ...(typeof record.customLabel === "string"
      ? { customLabel: record.customLabel }
      : {}),
  };
}

function upsertDiscoveredSession(
  list: DiscoveredSession[],
  session: DiscoveredSession,
): DiscoveredSession[] {
  const idx = list.findIndex((s) => s.tabId === session.tabId);
  if (idx < 0) return [...list, session];
  const next = [...list];
  next[idx] = session;
  return next;
}

export const handleSessionLabelChanged: BridgeMessageHandler = (
  message: BridgeMessage,
  ctx,
) => {
  const tabId = typeof message.tabId === "string" ? message.tabId : "";
  if (!tabId) return;
  const label = typeof message.label === "string" ? message.label : "";
  applyOptimisticTabLabel(ctx, tabId, label);

  const session = discoveredSessionFromMessage(message.session);
  if (!session) return;
  ctx.allDiscoveredSessionsRef.current = upsertDiscoveredSession(
    ctx.allDiscoveredSessionsRef.current,
    session,
  );
  ctx.syncRecentSessionsToState();
};
