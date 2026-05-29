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
      // Skip only projects that already resolved to a local (data:) icon.
      // A project still carrying a remote fallback (e.g. the GitHub-org
      // avatar) is re-checked so it can upgrade to an in-repo
      // favicon/logo — discoverIcon prefers a found local icon and keeps
      // the remote url otherwise. The in-memory TTL cache keeps the
      // re-check cheap (no IPC on a hit).
      if (project.iconUrl?.startsWith("data:")) continue;
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
