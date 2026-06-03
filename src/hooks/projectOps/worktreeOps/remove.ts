import type { MutableRefObject } from "react";
import { setProjectWorktrees, type ProjectsState } from "../../../projects";
import {
  gitWorktreeRemove,
  gitWorktreeRemoveOrphan,
  removeWorktreeFromList,
  type Worktree,
} from "../../../worktrees";
import { closeTabsForRemovedWorktree } from "./tabCleanup";
import type {
  ProjectLookups,
  WorktreeOperationDeps,
  WorktreeRemovalPrompts,
} from "./types";

interface RemoveDeps {
  projectsRef: MutableRefObject<ProjectsState>;
  lookups: ProjectLookups;
  syncProjectsToState: () => void;
  persistProjects: () => Promise<void>;
  tabCleanupDeps: {
    stateRef: WorktreeOperationDeps["stateRef"];
    tabBucketsRef: WorktreeOperationDeps["tabBucketsRef"];
    syncRecentSessionsToState: WorktreeOperationDeps["syncRecentSessionsToState"];
    closeTabNow: WorktreeOperationDeps["closeTabNow"];
    activateWorktree: (worktreeId: string | null) => void;
  };
  worktreePrompts: WorktreeRemovalPrompts;
}

export async function removeWorktreeById(
  deps: RemoveDeps,
  worktreeId: string,
  opts: { confirmed?: boolean } = {},
): Promise<void> {
  const hit = deps.lookups.findProjectOfWorktree(worktreeId);
  if (!hit) return;
  const { project, worktree } = hit;
  if (worktree.pendingState === "removing") return;
  if (worktree.isMain) {
    deps.worktreePrompts.notifyCannotRemoveMain();
    return;
  }
  const label = worktree.label ?? worktree.branch ?? "worktree";
  if (opts.confirmed !== true) {
    if (!(await deps.worktreePrompts.promptRemoveWorktree(label))) return;
  }

  const originalList = [
    ...(deps.projectsRef.current.worktreesByProject[project.id] ?? []),
  ];
  const originalWorktree: Worktree = { ...worktree };

  const applyOptimisticRemoval = (): void => {
    const next = (
      deps.projectsRef.current.worktreesByProject[project.id] ?? []
    ).map((w) =>
      w.id === worktreeId
        ? { ...w, pendingState: "removing" as const, pendingError: undefined }
        : w,
    );
    deps.projectsRef.current = setProjectWorktrees(
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
    closeTabsForRemovedWorktree(
      deps.tabCleanupDeps,
      project.id,
      worktreeId,
      worktree.path,
      deps.projectsRef.current.activeWorktreeId === worktreeId,
    );
    const next = removeWorktreeFromList(
      deps.projectsRef.current.worktreesByProject[project.id] ?? [],
      worktreeId,
    );
    deps.projectsRef.current = setProjectWorktrees(
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
      deps.projectsRef.current.worktreesByProject[project.id] ?? [];
    const existingIndex = currentList.findIndex((w) => w.id === worktreeId);
    const next = [...currentList];
    if (existingIndex >= 0) {
      next[existingIndex] = originalWorktree;
    } else {
      const originalIndex = originalList.findIndex((w) => w.id === worktreeId);
      if (originalIndex < 0 || originalIndex >= next.length) {
        next.push(originalWorktree);
      } else {
        next.splice(originalIndex, 0, originalWorktree);
      }
    }
    deps.projectsRef.current = setProjectWorktrees(
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
        worktreePath: worktree.path,
        force: false,
      });
      finalizeRemoval();
    } catch (err) {
      const msg = String(err);
      if (msg.includes("dirty") || msg.includes("modified")) {
        if (!(await deps.worktreePrompts.promptForceRemove(msg))) {
          restoreRemoval();
          return;
        }
        try {
          await gitWorktreeRemove({
            projectPath: project.path,
            worktreePath: worktree.path,
            force: true,
          });
          finalizeRemoval();
          return;
        } catch (e2) {
          deps.worktreePrompts.notifyFailure(String(e2));
          restoreRemoval();
          return;
        }
      }
      if (msg.includes("worktree not tracked")) {
        if (!(await deps.worktreePrompts.promptOrphanCleanup())) {
          restoreRemoval();
          return;
        }
        try {
          await gitWorktreeRemoveOrphan({
            projectPath: project.path,
            worktreePath: worktree.path,
          });
          finalizeRemoval();
          return;
        } catch (e2) {
          deps.worktreePrompts.notifyFailure(String(e2));
          restoreRemoval();
          return;
        }
      }
      deps.worktreePrompts.notifyFailure(msg);
      restoreRemoval();
    }
  };

  applyOptimisticRemoval();
  void removeInBackground();
}
