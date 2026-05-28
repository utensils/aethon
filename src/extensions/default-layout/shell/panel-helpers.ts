import { activeTabKind, type TabKind } from "../../../types/tab";

export const AGENT_BASH_SUB_ID = "agent-bash";

/** Pure resolver for "which sub-tab does the bottom panel actually render right now?" */
export function resolveActiveSubId(args: {
  requestedActiveId: string;
  shellTabIds: string[];
  showAgentBash: boolean;
}): string | null {
  const { requestedActiveId, shellTabIds, showAgentBash } = args;
  if (
    requestedActiveId !== AGENT_BASH_SUB_ID &&
    shellTabIds.includes(requestedActiveId)
  ) {
    return requestedActiveId;
  }
  if (showAgentBash) return AGENT_BASH_SUB_ID;
  return shellTabIds[0] ?? null;
}

/** Resolve the visible sub-tab id from a raw layout state snapshot. */
export function resolveActiveSubIdFromState(
  state: Record<string, unknown>,
): string | null {
  const panelState =
    (state["terminalPanel"] as { activeSubId?: string } | undefined) ?? {};
  const requestedActiveId = panelState.activeSubId ?? AGENT_BASH_SUB_ID;
  const tabs =
    (state["tabs"] as Array<{ id: string; kind?: TabKind }> | undefined) ?? [];
  const shellTabIds = tabs.filter((t) => t.kind === "shell").map((t) => t.id);
  const showAgentBash =
    activeTabKind(tabs, state["activeTabId"] as string | undefined) === "agent";
  return resolveActiveSubId({ requestedActiveId, shellTabIds, showAgentBash });
}
