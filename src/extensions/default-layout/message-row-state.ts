export function tabIsRunning(
  state: Record<string, unknown>,
  tabId?: string,
): boolean {
  if (state.waiting === true) return true;
  if (!tabId) return false;
  const runningTabs = state.agentRunningTabs;
  if (!runningTabs || typeof runningTabs !== "object") return false;
  return Boolean((runningTabs as Record<string, unknown>)[tabId]);
}
