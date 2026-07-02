import type { EventRouteHandler } from "./types";
import { cycleShareMode } from "../utils/shareMode";
import type { Tab } from "../types/tab";
import { WORKSTATION_AREAS, workstationRows } from "../hooks/useFocus";
import { reorderTabToIndex } from "../utils/tabReorder";
import { remoteHostInvoke } from "../services/remote";
import { isRemoteHostId } from "../hooks/tabOps/helpers";

const TERMINAL_PANEL_MIN_HEIGHT = 120;
const TERMINAL_PANEL_MAX_HEIGHT = 720;

function clampTerminalHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(
    TERMINAL_PANEL_MIN_HEIGHT,
    Math.min(TERMINAL_PANEL_MAX_HEIGHT, Math.round(value)),
  );
}

/** terminal-panel: the bottom panel hosting the read-only agent-bash
 *  sub-tab plus every shell as a sub-tab. Sub-tab select / close /
 *  new-shell live here. The agent-bash sub-tab can't be closed (no X
 *  button rendered), so a stray close request is a no-op. */
export const handleTerminalPanel: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (component.type !== "terminal-panel") return false;
  const sel = data as { subTabId?: string; toIndex?: number } | undefined;
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
  if (eventType === "reorder-sub-tab" && sel?.subTabId) {
    const subTabId = sel.subTabId;
    const toIndex = typeof sel.toIndex === "number" ? sel.toIndex : NaN;
    ctx.setState((prev) => {
      const tabs = (prev.tabs as Tab[] | undefined) ?? [];
      const reordered = reorderTabToIndex(tabs, "shell", subTabId, toIndex);
      return reordered ? { ...prev, tabs: reordered } : prev;
    });
    return true;
  }
  if (eventType === "resize") {
    const next = clampTerminalHeight(
      (data as { height?: unknown } | undefined)?.height,
    );
    if (next !== null) {
      ctx.setState((prev) => {
        const panel =
          (prev.terminalPanel as Record<string, unknown> | undefined) ?? {};
        if (panel.height === next) return prev;
        const terminal =
          (prev.terminal as { open?: boolean } | undefined) ?? {};
        const layout =
          (prev.layout as Record<string, unknown> | undefined) ?? {};
        return {
          ...prev,
          terminalPanel: { ...panel, height: next },
          layout: terminal.open
            ? {
                ...layout,
                rows: workstationRows(true, next),
                areas: WORKSTATION_AREAS,
              }
            : layout,
        };
      });
    }
    return true;
  }
  if (eventType === "resize-end") {
    // The debounced session UI snapshot persists /terminalPanel/height.
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
  const request = isRemoteHostId(tab.hostId)
    ? remoteHostInvoke(tab.hostId, "shell_set_share_mode", {
        tabId: id,
        mode: next,
      })
    : ctx.invoke("shell_set_share_mode", { tabId: id, mode: next });
  request
    .then(() => {
      ctx.applyShareModeToTab(id, next);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("shell_set_share_mode failed:", msg);
    });
  return true;
};
