import type { ContextUsageState } from "../../types/tab";
import type { BridgeMessage, BridgeMessageHandler } from "./types";

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function contextUsageFromMessage(
  data: BridgeMessage,
): ContextUsageState | null {
  const contextWindow = finiteNumber(data.contextWindow);
  if (contextWindow === null || contextWindow <= 0) return null;
  const compactAtTokens = finiteNumber(data.compactAtTokens);
  const reserveTokens = finiteNumber(data.reserveTokens);
  return {
    tabId: typeof data.tabId === "string" ? data.tabId : undefined,
    model: typeof data.model === "string" ? data.model : "",
    status: data.status === "known" ? "known" : "unknown",
    tokens: finiteNumber(data.tokens),
    contextWindow,
    percent: finiteNumber(data.percent),
    autoCompactEnabled: data.autoCompactEnabled === true,
    reserveTokens: reserveTokens ?? 0,
    compactAtTokens: compactAtTokens ?? contextWindow,
    tokensUntilCompact: finiteNumber(data.tokensUntilCompact),
    ...(data.compacting === true ? { compacting: true } : {}),
    ...(data.saturated === true ? { saturated: true } : {}),
  };
}

export const handleContextUsage: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  const contextUsage = contextUsageFromMessage(data);
  if (!contextUsage) return;
  ctx.updateTab(tabId, (tab) => ({ ...tab, contextUsage }));
};
