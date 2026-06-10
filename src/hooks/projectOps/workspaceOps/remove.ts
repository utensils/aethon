import type { MutableRefObject } from "react";
import { setProjectWorkspaces, type ProjectsState } from "../../../projects";
import {
  gitWorktreeRemove,
  gitWorktreeRemoveOrphan,
  removeWorkspaceFromList,
  type Workspace,
} from "../../../workspaces";
import {
  closeTabsForRemovedWorkspace,
  type TabCleanupDeps,
} from "./tabCleanup";
import type { ProjectLookups, WorkspaceRemovalPrompts } from "./types";

interface RemoveDeps {
  projectsRef: MutableRefObject<ProjectsState>;
  lookups: ProjectLookups;
  syncProjectsToState: () => void;
  persistProjects: () => Promise<void>;
  tabCleanupDeps: TabCleanupDeps;
  workspacePrompts: WorkspaceRemovalPrompts;
}

export async function removeWorkspaceById(
  deps: RemoveDeps,
  workspaceId: string,
  opts: { confirmed?: boolean } = {},
): Promise<void> {
  const hit = deps.lookups.findProjectOfWorkspace(workspaceId);
  if (!hit) return;
  const { project, workspace } = hit;
  if (workspace.pendingState === "removing") return;
  if (workspace.isMain) {
    deps.workspacePrompts.notifyCannotRemoveMain();
    return;
  }
  const label = workspace.label ?? workspace.branch ?? "workspace";
  if (opts.confirmed !== true) {
    if (!(await deps.workspacePrompts.promptRemoveWorkspace(label))) return;
  }

  const originalList = [
    ...(deps.projectsRef.current.workspacesByProject[project.id] ?? []),
  ];
  const originalWorkspace: Workspace = { ...workspace };

  const applyOptimisticRemoval = (): void => {
    const next = (
      deps.projectsRef.current.workspacesByProject[project.id] ?? []
    ).map((w) =>
      w.id === workspaceId
        ? { ...w, pendingState: "removing" as const, pendingError: undefined }
        : w,
    );
    deps.projectsRef.current = setProjectWorkspaces(
      deps.projectsRef.current,
      project.id,
      next,
    );
    deps.syncProjectsToState();
  };

  const finalizeRemoval = (): void => {
    const projectStillExists = deps.projectsRef.current.projects.some(
      (p) => p.id === project.id,
    );
    if (!projectStillExists) return;
    closeTabsForRemovedWorkspace(
      deps.tabCleanupDeps,
      project.id,
      workspaceId,
      workspace.path,
      deps.projectsRef.current.activeWorkspaceId === workspaceId,
    );
    const next = removeWorkspaceFromList(
      deps.projectsRef.current.workspacesByProject[project.id] ?? [],
      workspaceId,
    );
    deps.projectsRef.current = setProjectWorkspaces(
      deps.projectsRef.current,
      project.id,
      next,
    );
    deps.syncProjectsToState();
    void deps.persistProjects();
  };

  const restoreRemoval = (): void => {
    const projectStillExists = deps.projectsRef.current.projects.some(
      (p) => p.id === project.id,
    );
    if (!projectStillExists) return;
    const currentList =
      deps.projectsRef.current.workspacesByProject[project.id] ?? [];
    const existingIndex = currentList.findIndex((w) => w.id === workspaceId);
    const next = [...currentList];
    if (existingIndex >= 0) {
      next[existingIndex] = originalWorkspace;
    } else {
      const originalIndex = originalList.findIndex((w) => w.id === workspaceId);
      if (originalIndex < 0 || originalIndex >= next.length) {
        next.push(originalWorkspace);
      } else {
        next.splice(originalIndex, 0, originalWorkspace);
      }
    }
    deps.projectsRef.current = setProjectWorkspaces(
      deps.projectsRef.current,
      project.id,
      next,
    );
    deps.syncProjectsToState();
    void deps.persistProjects();
  };

  const removeInBackground = async (): Promise<void> => {
    try {
      await gitWorktreeRemove({
        projectPath: project.path,
        workspacePath: workspace.path,
        force: false,
      });
      finalizeRemoval();
    } catch (err) {
      const msg = String(err);
      if (msg.includes("dirty") || msg.includes("modified")) {
        if (!(await deps.workspacePrompts.promptForceRemove(msg))) {
          restoreRemoval();
          return;
        }
        try {
          await gitWorktreeRemove({
            projectPath: project.path,
            workspacePath: workspace.path,
            force: true,
          });
          finalizeRemoval();
          return;
        } catch (e2) {
          deps.workspacePrompts.notifyFailure(String(e2));
          restoreRemoval();
          return;
        }
      }
      if (msg.includes("workspace not tracked")) {
        if (!(await deps.workspacePrompts.promptOrphanCleanup())) {
          restoreRemoval();
          return;
        }
        try {
          await gitWorktreeRemoveOrphan({
            projectPath: project.path,
            workspacePath: workspace.path,
          });
          finalizeRemoval();
          return;
        } catch (e2) {
          deps.workspacePrompts.notifyFailure(String(e2));
          restoreRemoval();
          return;
        }
      }
      deps.workspacePrompts.notifyFailure(msg);
      restoreRemoval();
    }
  };

  applyOptimisticRemoval();
  void removeInBackground();
}
