import { setPointer } from "../../utils/jsonPointer";
import { TAB_MIRROR_KEYS } from "../useTabs";
import type { Tab } from "../../types/tab";
import type { BridgeMessageHandler } from "./types";

/** An extension pushed a state mutation. Two cases:
 *
 *   1. Path is a per-tab mirrored key (messages / draft / waiting /
 *      queueCount / canvas / model):
 *      - With data.tabId: route ONLY to that tab. updateTab will also
 *        write to root if it happens to be the active tab. Don't
 *        pre-mirror to root — that would briefly clobber the active
 *        tab's view with a background tab's state.
 *      - Without data.tabId: global setState with no tab context (clock
 *        interval, polling extension). Apply to the active tab so the
 *        layout sees it and a switch-back re-mirrors.
 *   2. Path is global (anything else, e.g. /sidebar/..., /counter/value,
 *      /custom): write directly to root state. No tab-scoping needed —
 *      these aren't mirrored. */
export const handleStatePatch: BridgeMessageHandler = (data, ctx) => {
  const path = data.path as string | undefined;
  if (!path) {
    ctx.ackMutation(data.mutationId, false, "missing path");
    return;
  }
  const segs = path.split("/").filter(Boolean);
  const top = segs[0] as keyof Tab | undefined;
  const isMirrored = top !== undefined && TAB_MIRROR_KEYS.includes(top);
  if (isMirrored) {
    const writeIntoTab = (tab: Tab): Tab => {
      const tabRec = { ...tab } as unknown as Record<string, unknown>;
      if (segs.length === 1) {
        tabRec[top as string] = data.value;
      } else {
        const before = tabRec[top as string];
        const baseObj =
          typeof before === "object" && before !== null
            ? (before as Record<string, unknown>)
            : {};
        const nested = setPointer(baseObj, "/" + segs.slice(1).join("/"), data.value);
        tabRec[top as string] = nested;
      }
      return tabRec as unknown as Tab;
    };
    const sourceTabId = data.tabId as string | undefined;
    if (sourceTabId) {
      ctx.updateTab(sourceTabId, writeIntoTab);
    } else {
      ctx.updateActiveTab(writeIntoTab);
    }
  } else {
    ctx.setState((prev) => setPointer(prev, path, data.value));
    // Track this path as extension-owned so the next `ready` knows to
    // prune it if the extension that wrote it is gone. Without this,
    // paths written via setState AFTER the last ready would never appear
    // in lastExtensionStateKeysRef and would survive an extension
    // uninstall as stale UI.
    ctx.lastExtensionStateKeysRef.current.add(path);
  }
  ctx.ackMutation(data.mutationId, true);
};
