export function tabIsRunning(
  state: Record<string, unknown>,
  tabId?: string,
): boolean {
  if (!tabId) return state.waiting === true;
  const runningTabs = state.agentRunningTabs;
  if (
    runningTabs &&
    typeof runningTabs === "object" &&
    Boolean((runningTabs as Record<string, unknown>)[tabId])
  ) {
    return true;
  }
  const activeTabId =
    typeof state.activeTabId === "string" ? state.activeTabId : undefined;
  if (activeTabId !== undefined && activeTabId !== tabId) return false;
  return state.waiting === true;
}
