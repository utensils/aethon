import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { OVERVIEW_TAB_ID, type Tab } from "../types/tab";

export interface UseTabNavigationContext {
  stateRef: MutableRefObject<Record<string, unknown>>;
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  /** Switches the active *agent* tab — re-mirrors TAB_MIRROR_KEYS into
   *  the root state and replays the terminal buffer. The hook only
   *  computes which id to switch to; the heavy lifting stays in App. */
  setActiveTab: (tabId: string) => void;
  /** Switches the active sub-tab in the bottom terminal panel. Sub-tab
   *  ids are either the literal "agent-bash" or a shell tab id. */
  setActiveSubTab: (subId: string) => void;
}

export interface UseTabNavigationActions {
  /** Cycle the active top-strip tab one slot. Includes both agent
   *  (chat) and editor tabs; skips shells (they own the bottom panel).
   *  The overview pill is the leftmost slot; cycling does **not** wrap —
   *  going left past the first tab lands on overview and stops, going
   *  right past the last tab stays put. */
  nextTab: (direction: 1 | -1) => void;
  /** Jump to the top-strip tab at zero-based index. Includes both
   *  agent and editor tabs in left-to-right order. Out-of-range is
   *  silent (Cmd+5 with only 3 top-strip tabs is a no-op). */
  jumpToTab: (idx: number) => void;
  /** Reorder the active tab one slot left (-1) or right (+1). Wraps. */
  moveActiveTab: (direction: 1 | -1) => void;
  /** Cycle the active sub-tab in the bottom panel. Order is
   *  agent-bash first, then shells in /tabs order. Wraps. */
  nextShellSubTab: (direction: 1 | -1) => void;
  /** Idx 0 selects agent-bash; idx 1+ selects the corresponding shell
   *  sub-tab. Out-of-range is silent. */
  jumpToShellSubTab: (idx: number) => void;
  /** Reorder the active shell sub-tab within /tabs (agent-bash is
   *  pinned first; trying to move it is a no-op). */
  moveActiveShellSubTab: (direction: 1 | -1) => void;
}

/**
 * Pure tab/sub-tab navigation. Each action computes the target id from
 * the live state ref and delegates to the caller's setActiveTab /
 * setActiveSubTab orchestrators. Heavier lifecycle functions
 * (newTab, closeTab, setActiveTab itself) stay in App.tsx for now —
 * they have wider dependencies (project bucket swap, terminal replay,
 * model picker recompute) that will move with a future useTabs
 * extraction.
 */
export function useTabNavigation(
  ctx: UseTabNavigationContext,
): UseTabNavigationActions {
  const { stateRef, setState, setActiveTab, setActiveSubTab } = ctx;

  const nextTab = useCallback(
    (direction: 1 | -1) => {
      // Top-strip tabs only: agent + editor. Shell sub-tabs cycle via
      // nextShellSubTab when focus is inside the bottom panel.
      const tabs = ((stateRef.current.tabs as Tab[] | undefined) ?? [])
        .filter((t) => t.kind !== "shell");
      if (tabs.length === 0) return;
      // Model the strip as [overview, tab0, … tabN-1] and clamp — cycling
      // never wraps. overview is position -1; tabK is position k. Anything
      // that isn't a known top-strip tab (no active id, the overview
      // sentinel, or focus in the bottom panel) counts as overview.
      const activeId = stateRef.current.activeTabId as string | undefined;
      const known = tabs.findIndex((t) => t.id === activeId);
      const pos = known < 0 ? -1 : known;
      const target = pos + direction;
      if (target < -1 || target > tabs.length - 1) return; // at a boundary
      setActiveTab(target < 0 ? OVERVIEW_TAB_ID : tabs[target].id);
    },
    [stateRef, setActiveTab],
  );

  const jumpToTab = useCallback(
    (idx: number) => {
      const tabs = ((stateRef.current.tabs as Tab[] | undefined) ?? [])
        .filter((t) => t.kind !== "shell");
      if (tabs.length === 0) return;
      if (idx < 0 || idx >= tabs.length) return;
      setActiveTab(tabs[idx].id);
    },
    [stateRef, setActiveTab],
  );

  const jumpToShellSubTab = useCallback(
    (idx: number) => {
      if (idx === 0) {
        setActiveSubTab("agent-bash");
        return;
      }
      const shellTabs = ((stateRef.current.tabs as Tab[] | undefined) ?? [])
        .filter((t) => t.kind === "shell");
      const shellIdx = idx - 1;
      if (shellIdx < 0 || shellIdx >= shellTabs.length) return;
      setActiveSubTab(shellTabs[shellIdx].id);
    },
    [stateRef, setActiveSubTab],
  );

  const nextShellSubTab = useCallback(
    (direction: 1 | -1) => {
      const subIds = ["agent-bash" as string].concat(
        ((stateRef.current.tabs as Tab[] | undefined) ?? [])
          .filter((t) => t.kind === "shell")
          .map((t) => t.id),
      );
      if (subIds.length <= 1) return;
      const cur = (stateRef.current.terminalPanel as
        | { activeSubId?: string }
        | undefined)?.activeSubId ?? "agent-bash";
      const idx = Math.max(0, subIds.indexOf(cur));
      const nextIdx = (idx + direction + subIds.length) % subIds.length;
      setActiveSubTab(subIds[nextIdx]);
    },
    [stateRef, setActiveSubTab],
  );

  const moveActiveShellSubTab = useCallback(
    (direction: 1 | -1) => {
      const activeSub = (stateRef.current.terminalPanel as
        | { activeSubId?: string }
        | undefined)?.activeSubId;
      if (!activeSub || activeSub === "agent-bash") return;
      setState((prev) => {
        const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
        const shellPositions = tabs
          .map((t, i) => (t.kind === "shell" ? i : -1))
          .filter((i) => i >= 0);
        if (shellPositions.length <= 1) return prev;
        const idx = tabs.findIndex((t) => t.id === activeSub);
        if (idx < 0) return prev;
        const subPos = shellPositions.indexOf(idx);
        if (subPos < 0) return prev;
        const swapSubPos =
          (subPos + direction + shellPositions.length) % shellPositions.length;
        const swapIdx = shellPositions[swapSubPos];
        const tmp = tabs[idx];
        tabs[idx] = tabs[swapIdx];
        tabs[swapIdx] = tmp;
        return { ...prev, tabs };
      });
    },
    [stateRef, setState],
  );

  const moveActiveTab = useCallback(
    (direction: 1 | -1) => {
      const activeId = stateRef.current.activeTabId as string | undefined;
      if (!activeId) return;
      setState((prev) => {
        const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
        if (tabs.length <= 1) return prev;
        const idx = tabs.findIndex((t) => t.id === activeId);
        if (idx < 0) return prev;
        const nextIdx = (idx + direction + tabs.length) % tabs.length;
        const [moved] = tabs.splice(idx, 1);
        tabs.splice(nextIdx, 0, moved);
        return { ...prev, tabs };
      });
    },
    [stateRef, setState],
  );

  return {
    nextTab,
    jumpToTab,
    moveActiveTab,
    nextShellSubTab,
    jumpToShellSubTab,
    moveActiveShellSubTab,
  };
}
