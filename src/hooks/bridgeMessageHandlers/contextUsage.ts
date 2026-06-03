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
  const tokens = finiteNumber(data.tokens);
  const estimatedTokens = finiteNumber(data.estimatedTokens) ?? tokens;
  const transientTokens = finiteNumber(data.transientTokens) ?? 0;
  const saturatedByProvider =
    data.saturatedByProvider === true || data.saturated === true;
  return {
    tabId: typeof data.tabId === "string" ? data.tabId : undefined,
    model: typeof data.model === "string" ? data.model : "",
    status: data.status === "known" ? "known" : "unknown",
    tokens,
    contextWindow,
    percent: finiteNumber(data.percent),
    estimatedTokens,
    estimatedPercent: finiteNumber(data.estimatedPercent),
    transientTokens,
    autoCompactEnabled: data.autoCompactEnabled === true,
    reserveTokens: reserveTokens ?? 0,
    compactAtTokens: compactAtTokens ?? contextWindow,
    tokensUntilCompact: finiteNumber(data.tokensUntilCompact),
    estimatedTokensUntilCompact: finiteNumber(data.estimatedTokensUntilCompact),
    ...(data.compacting === true ? { compacting: true } : {}),
    ...(saturatedByProvider ? { saturatedByProvider: true, saturated: true } : {}),
    ...(data.saturatedByEstimate === true ? { saturatedByEstimate: true } : {}),
  };
}

export const handleContextUsage: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  const contextUsage = contextUsageFromMessage(data);
  if (!contextUsage) return;
  ctx.updateTab(tabId, (tab) => ({ ...tab, contextUsage }));
};
