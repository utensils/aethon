import { useCallback, useEffect, type MutableRefObject } from "react";
import type { ProjectsState } from "../projects";
import { discoverIcon } from "../projectIcons";
import type { Tab } from "../types/tab";
import { worktreeIdForCwd } from "./useProjectOps";

export interface UseProjectSyncEffectsOptions {
  state: Record<string, unknown>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  setActiveProjectById: (id: string) => boolean;
  activateWorktree: (worktreeId: string | null) => void;
  setProjectIconUrl: (projectId: string, iconUrl: string) => void;
}

export function useProjectSyncEffects({
  state,
  stateRef,
  projectsRef,
  setActiveProjectById,
  activateWorktree,
  setProjectIconUrl,
}: UseProjectSyncEffectsOptions): void {
  const syncActiveWorktreeToActiveTab = useCallback(() => {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeId = stateRef.current.activeTabId as string | undefined;
    const active = activeId ? tabs.find((t) => t.id === activeId) : undefined;
    if (!active || active.kind !== "agent") return;
    const resolved = worktreeIdForCwd(
      projectsRef.current,
      active.cwd,
      active.projectId,
    );
    if (resolved === undefined) return;
    if (active.projectId && projectsRef.current.activeId !== active.projectId) {
      if (!setActiveProjectById(active.projectId)) return;
    }
    if (projectsRef.current.activeWorktreeId !== resolved) {
      activateWorktree(resolved);
    }
  }, [activateWorktree, projectsRef, setActiveProjectById, stateRef]);

  useEffect(() => {
    syncActiveWorktreeToActiveTab();
  }, [
    syncActiveWorktreeToActiveTab,
    state.activeTabId,
    state.activeWorktreeId,
    state.cwd,
    state.projects,
    state.sidebar,
  ]);

  const discoverIconsForProjects = useCallback(() => {
    const ps = projectsRef.current.projects;
    for (const project of ps) {
      if (project.iconUrl) continue;
      void (async () => {
        const url = await discoverIcon(project);
        if (!url) return;
        if (!projectsRef.current.projects.some((p) => p.id === project.id)) {
          return;
        }
        setProjectIconUrl(project.id, url);
      })();
    }
  }, [projectsRef, setProjectIconUrl]);

  useEffect(() => {
    discoverIconsForProjects();
  }, [discoverIconsForProjects, state.projects]);
}
