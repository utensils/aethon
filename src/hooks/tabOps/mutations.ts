import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ShellMeta, Tab } from "../../types/tab";
import { OVERVIEW_TAB_ID } from "../../types/tab";
import { recomputeModelPicker } from "../../utils/modelPicker";
import { TAB_MIRROR_KEYS, VALID_SHARE_MODES } from "./constants";
import {
  mirrorOverviewSurfaceSelection,
  mirrorOverviewSurfaceToRoot,
} from "./helpers";

/** Tell the shared xterm panel to clear and replay a tab's terminal
 *  buffer. Microtask deferral so xterm's mount-once useEffect has
 *  resolved before we try to write to it. Defined as a free function
 *  because it has no closure dependencies — every other tab action
 *  here just calls into it. */
export function dispatchTerminalReplay(buffer: string): void {
  Promise.resolve().then(() => {
    window.dispatchEvent(
      new CustomEvent("aethon:terminal-replay", { detail: buffer }),
    );
  });
}

export interface MutationsDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
}

export interface MutationsActions {
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  updateActiveTab: (mutator: (tab: Tab) => Tab) => void;
  applyShareModeToTab: (tabId: string, mode: string) => void;
  setActiveTab: (tabId: string) => void;
  setActiveSubTab: (subId: string) => void;
}

function mirrorTabToRoot(
  result: Record<string, unknown>,
  sourceState: Record<string, unknown>,
  tab: Tab,
): string {
  const tabRec = tab as unknown as Record<string, unknown>;
  for (const key of TAB_MIRROR_KEYS) {
    result[key as string] = tabRec[key as string];
  }
  if (tab.kind !== "shell") return tab.model || "";

  return mirrorOverviewSurfaceToRoot(result, sourceState);
}

/** Mirror writes + active-tab switching. These are the lowest-level
 *  tab mutations — everything else builds on `updateTab` /
 *  `updateActiveTab` (which copy TAB_MIRROR_KEYS into the root state
 *  for layout `$ref` bindings) and on `setActiveTab` (which both
 *  switches the active id and triggers a terminal replay). */
export function useMutations(deps: MutationsDeps): MutationsActions {
  const { setState, stateRef } = deps;

  function updateTab(tabId: string, mutator: (tab: Tab) => Tab): void {
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = mutator(tabs[idx]);
      tabs[idx] = next;
      const result: Record<string, unknown> = { ...prev, tabs };
      if (prev.activeTabId === tabId) {
        mirrorTabToRoot(result, prev, next);
      }
      return result;
    });
  }

  function updateActiveTab(mutator: (tab: Tab) => Tab): void {
    setState((prev) => {
      const activeId = prev.activeTabId as string | undefined;
      if (!activeId) return prev;
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const idx = tabs.findIndex((t) => t.id === activeId);
      if (idx < 0) return prev;
      const next = mutator(tabs[idx]);
      tabs[idx] = next;
      const result: Record<string, unknown> = { ...prev, tabs };
      mirrorTabToRoot(result, prev, next);
      return result;
    });
  }

  /** Mirror a share-mode change from the Rust source-of-truth into the
   *  React Tab record. Cheap no-op if the tab doesn't exist or isn't a
   *  shell tab. The Rust side enforces the actual privacy boundary —
   *  this just keeps the badge UI honest. */
  function applyShareModeToTab(tabId: string, mode: string): void {
    if (!tabId) return;
    if (!VALID_SHARE_MODES.includes(mode as ShellMeta["shareMode"])) return;
    updateTab(tabId, (t) => {
      if (t.kind !== "shell" || !t.shell) return t;
      if (t.shell.shareMode === mode) return t;
      return {
        ...t,
        shell: {
          ...t.shell,
          shareMode: mode as ShellMeta["shareMode"],
        },
      };
    });
  }

  /** Switch the active tab. Re-mirrors the new tab's view to the root
   *  keys so layout bindings update without per-key refresh, plus
   *  dispatches a terminal replay so the shared xterm clears and
   *  re-writes the new tab's buffered output. */
  function setActiveTab(tabId: string): void {
    if (tabId === OVERVIEW_TAB_ID) {
      setState((prev) => {
        const result: Record<string, unknown> = {
          ...prev,
          activeTabId: OVERVIEW_TAB_ID,
          landing: null,
        };
        const visibleModel = mirrorOverviewSurfaceSelection(result, prev);
        const desiredThinkingLevel = result.thinkingLevel;
        const alreadyClean =
          prev.activeTabId === OVERVIEW_TAB_ID &&
          prev.landing == null &&
          (visibleModel ? prev.model === visibleModel : true) &&
          prev.thinkingLevel === desiredThinkingLevel;
        if (alreadyClean) {
          return prev;
        }
        return result;
      });
      dispatchTerminalReplay("");
      return;
    }
    let nextBuffer = "";
    setState((prev) => {
      const tabs = (prev.tabs as Tab[] | undefined) ?? [];
      const target = tabs.find((t) => t.id === tabId);
      if (!target) return prev;
      nextBuffer = target.terminalBuffer ?? "";
      const result: Record<string, unknown> = { ...prev, activeTabId: tabId };
      const attention = prev.agentAttentionTabs as
        | Record<string, true>
        | undefined;
      if (attention?.[tabId]) {
        const nextAttention = { ...attention };
        delete nextAttention[tabId];
        result.agentAttentionTabs = nextAttention;
      }
      const visibleModel = mirrorTabToRoot(result, prev, target);
      result.sidebar = recomputeModelPicker(
        prev.sidebar as Record<string, unknown> | undefined,
        visibleModel,
      );
      // Selecting any tab clears a workspace-landing override so the
      // chat canvas can render. Without this, clicking a tab while the
      // landing was visible would leave the landing stuck on top.
      result.landing = null;
      return result;
    });
    dispatchTerminalReplay(nextBuffer);
  }

  /** Switch which sub-tab is active in the bottom terminal panel. Sub-tab
   *  id is either "agent-bash" or a shell tab id from /tabs. Auto-opens
   *  the panel if hidden. When switching back to agent-bash, replay the
   *  active agent tab's terminalBuffer so the freshly-mounted Terminal
   *  composite sees its content. */
  function setActiveSubTab(subId: string): void {
    setState((prev) => {
      const panel =
        (prev.terminalPanel as { activeSubId?: string } | undefined) ?? {};
      const term = (prev.terminal as { open?: boolean } | undefined) ?? {};
      if (panel.activeSubId === subId && term.open === true) {
        return prev;
      }
      return {
        ...prev,
        terminalPanel: { ...panel, activeSubId: subId },
        terminal: { ...term, open: true },
      };
    });
    if (subId === "agent-bash") {
      requestAnimationFrame(() => {
        const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
        const activeId = stateRef.current.activeTabId as string | undefined;
        const active = activeId
          ? tabs.find((t) => t.id === activeId)
          : undefined;
        const buffer = active?.terminalBuffer ?? "";
        dispatchTerminalReplay(buffer);
      });
    }
  }

  return {
    updateTab,
    updateActiveTab,
    applyShareModeToTab,
    setActiveTab,
    setActiveSubTab,
  };
}
