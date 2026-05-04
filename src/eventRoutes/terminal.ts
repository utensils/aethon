import type { EventRouteHandler } from "./types";
import { cycleShareMode } from "../utils/shareMode";
import type { Tab } from "../types/tab";

/** terminal-panel: the bottom panel hosting the read-only agent-bash
 *  sub-tab plus every shell as a sub-tab. Sub-tab select / close /
 *  new-shell live here. The agent-bash sub-tab can't be closed (no X
 *  button rendered), so a stray close request is a no-op. */
export const handleTerminalPanel: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (component.type !== "terminal-panel") return false;
  const sel = data as { subTabId?: string } | undefined;
  if (eventType === "select-sub-tab" && sel?.subTabId) {
    ctx.setActiveSubTab(sel.subTabId);
    return true;
  }
  if (eventType === "close-sub-tab" && sel?.subTabId) {
    if (sel.subTabId !== "agent-bash") {
      ctx.closeTab(sel.subTabId);
    }
    return true;
  }
  if (eventType === "new-shell-sub-tab") {
    ctx.newShellTab();
    return true;
  }
  return false;
};

/** Share-mode badge cycle. Match either source: the inline badge inside
 *  ShellCanvas re-emits on the shell-canvas channel; a standalone
 *  `<share-mode-badge>` placed directly in a custom layout emits on
 *  its own component type. Persists through the Rust side AND mirrors
 *  locally so the badge label refreshes immediately. */
export const handleShareModeCycle: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (
    eventType !== "cycle-share-mode" ||
    (component.type !== "shell-canvas" &&
      component.type !== "share-mode-badge")
  ) {
    return false;
  }
  const sel = data as { tabId?: string } | undefined;
  const id = sel?.tabId;
  if (typeof id !== "string" || !id) return true;
  const tabs = (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tab.kind !== "shell" || !tab.shell) return true;
  const next = cycleShareMode(tab.shell.shareMode);
  ctx
    .invoke("shell_set_share_mode", { tabId: id, mode: next })
    .then(() => {
      ctx.applyShareModeToTab(id, next);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("shell_set_share_mode failed:", msg);
    });
  return true;
};
