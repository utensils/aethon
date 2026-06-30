import { useEffect, useState } from "react";

export interface AgentActivityState {
  label: string;
  detail: string;
  startedAt: number;
  updatedAt: number;
}

export const AGENT_ACTIVITY_REVEAL_DELAY_MS = 500;

export function agentActivityForTab(
  state: Record<string, unknown>,
  tabId?: string,
): AgentActivityState | null {
  const map = state.agentActivityByTab;
  if (!map || typeof map !== "object") return null;
  const targetTabId =
    tabId ?? (typeof state.activeTabId === "string" ? state.activeTabId : "");
  if (!targetTabId) return null;
  const activity = (map as Record<string, unknown>)[targetTabId];
  if (!activity || typeof activity !== "object") return null;
  const raw = activity as Record<string, unknown>;
  if (
    typeof raw.label !== "string" ||
    typeof raw.detail !== "string" ||
    typeof raw.startedAt !== "number" ||
    typeof raw.updatedAt !== "number"
  ) {
    return null;
  }
  return {
    label: raw.label,
    detail: raw.detail,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
  };
}

export function useDelayedAgentActivity(
  activity: AgentActivityState | null,
): AgentActivityState | null {
  const [visibleStartedAt, setVisibleStartedAt] = useState<number | null>(null);
  const startedAt = activity?.startedAt ?? null;
  useEffect(() => {
    if (startedAt === null) return;
    const delay = Math.max(
      0,
      AGENT_ACTIVITY_REVEAL_DELAY_MS - (Date.now() - startedAt),
    );
    const timer = window.setTimeout(() => {
      setVisibleStartedAt(startedAt);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [startedAt]);
  if (!activity || visibleStartedAt !== activity.startedAt) return null;
  return activity;
}
