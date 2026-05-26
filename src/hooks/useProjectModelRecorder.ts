import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Tab } from "../types/tab";

export function useProjectModelRecorder(
  setState: Dispatch<SetStateAction<Record<string, unknown>>>,
): (model: string, tabId?: string) => void {
  return useCallback(
    (model: string, tabId?: string) => {
      if (!model.trim()) return;
      setState((prev) => {
        const tabs = (prev.tabs as Tab[] | undefined) ?? [];
        const targetId =
          tabId ?? (prev.activeTabId as string | undefined) ?? undefined;
        const tab = targetId ? tabs.find((t) => t.id === targetId) : undefined;
        const projectId = tab?.projectId ?? null;
        if (!projectId) return prev;
        const projectModels =
          (prev.projectModels as Record<string, string> | undefined) ?? {};
        if (projectModels[projectId] === model) return prev;
        return {
          ...prev,
          projectModels: { ...projectModels, [projectId]: model },
        };
      });
    },
    [setState],
  );
}
