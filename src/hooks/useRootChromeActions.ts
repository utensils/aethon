import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { NotificationInput } from "./useNotifications";
import type { Tab } from "../types/tab";

export interface UseRootChromeActionsContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  updateActiveTab: (updater: (tab: Tab) => Tab) => void;
  pushNotification: (notification: NotificationInput) => void;
}

export interface RootChromeActions {
  openScheduledTasks: () => void;
  closeScheduledTasks: () => void;
  togglePlanMode: () => void;
  toggleAccounts: () => void;
}

function setScheduledTasksOpen(
  setState: Dispatch<SetStateAction<Record<string, unknown>>>,
  open: boolean,
): void {
  setState((prev) => ({
    ...prev,
    scheduledTasks: {
      ...((prev.scheduledTasks ?? {}) as Record<string, unknown>),
      open,
    },
  }));
}

export function useRootChromeActions(
  ctx: UseRootChromeActionsContext,
): RootChromeActions {
  const { setState, stateRef, updateActiveTab, pushNotification } = ctx;

  const openScheduledTasks = useCallback(() => {
    setScheduledTasksOpen(setState, true);
  }, [setState]);

  const closeScheduledTasks = useCallback(() => {
    setScheduledTasksOpen(setState, false);
  }, [setState]);

  const togglePlanMode = useCallback(() => {
    const activeId = stateRef.current.activeTabId as string | undefined;
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeTab = tabs.find((tab) => tab.id === activeId);
    if (!activeTab || activeTab.kind !== "agent") return;
    const enabled = activeTab.planMode !== true;
    updateActiveTab((tab) =>
      tab.kind === "agent" ? { ...tab, planMode: enabled } : tab,
    );
    pushNotification({
      title: enabled ? "Plan mode on" : "Implementation mode on",
      message: enabled
        ? "New prompts will ask for a plan before code changes."
        : "New prompts may make code changes.",
      kind: "success",
      durationMs: 1600,
    });
  }, [pushNotification, stateRef, updateActiveTab]);

  const toggleAccounts = useCallback(() => {
    setState((prev) => {
      const auth = (prev.authProfiles ?? {}) as Record<string, unknown>;
      const modal = (auth.modal ?? {}) as Record<string, unknown>;
      return {
        ...prev,
        authProfiles: { ...auth, modal: { ...modal, open: !modal.open } },
      };
    });
  }, [setState]);

  return {
    openScheduledTasks,
    closeScheduledTasks,
    togglePlanMode,
    toggleAccounts,
  };
}
