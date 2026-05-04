import { TAB_MIRROR_KEYS } from "../useTabs";
import type { Tab } from "../../types/tab";
import type { BridgeMessageHandler } from "./types";
import { recomputeModelPicker } from "../../utils/modelPicker";

/** Bridge confirms a tab session was torn down. We may have already
 *  removed it from local state in the close handler; this is just a
 *  signal in case some other path triggered the close. */
export const handleTabClosed: BridgeMessageHandler = (data, ctx) => {
  const tabId = data.tabId as string | undefined;
  if (!tabId) return;
  let nextBuffer = "";
  let switched = false;
  ctx.setState((prev) => {
    const tabs = ((prev.tabs as Tab[] | undefined) ?? []).filter(
      (t) => t.id !== tabId,
    );
    if (tabs.length === 0) return prev; // shouldn't happen — bridge refuses to close default
    let activeTabId = prev.activeTabId as string | undefined;
    if (activeTabId === tabId) {
      activeTabId = tabs[tabs.length - 1].id;
      switched = true;
    }
    const result: Record<string, unknown> = { ...prev, tabs, activeTabId };
    const target = tabs.find((t) => t.id === activeTabId)!;
    nextBuffer = target.terminalBuffer ?? "";
    const targetRec = target as unknown as Record<string, unknown>;
    for (const key of TAB_MIRROR_KEYS) {
      result[key as string] = targetRec[key as string];
    }
    result.sidebar = recomputeModelPicker(
      prev.sidebar as Record<string, unknown> | undefined,
      target.model,
    );
    return result;
  });
  if (switched) ctx.dispatchTerminalReplay(nextBuffer);
};
