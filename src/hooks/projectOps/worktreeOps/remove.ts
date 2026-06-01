import type { MutableRefObject } from "react";
import type { ProjectsState } from "../../../projects";
import {
  gitWorktreeRemove,
  gitWorktreeRemoveOrphan,
} from "../../../worktrees";
import { applyWorktreeRemoval } from "./state";
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
  if (worktree.isMain) {
    deps.worktreePrompts.notifyCannotRemoveMain();
    return;
  }
  const label = worktree.label ?? worktree.branch ?? "worktree";
  if (opts.confirmed !== true) {
    if (!(await deps.worktreePrompts.promptRemoveWorktree(label))) return;
  }

  const applyRemoval = (): void => {
    closeTabsForRemovedWorktree(
      deps.tabCleanupDeps,
      project.id,
      worktreeId,
      worktree.path,
      deps.projectsRef.current.activeWorktreeId === worktreeId,
    );
    applyWorktreeRemoval(
      {
        projectsRef: deps.projectsRef,
        syncProjectsToState: deps.syncProjectsToState,
        persistProjects: deps.persistProjects,
      },
      project.id,
      worktreeId,
    );
  };

  try {
    await gitWorktreeRemove({
      projectPath: project.path,
      worktreePath: worktree.path,
      force: false,
    });
    applyRemoval();
  } catch (err) {
    const msg = String(err);
    if (msg.includes("dirty") || msg.includes("modified")) {
      if (!(await deps.worktreePrompts.promptForceRemove(msg))) return;
      try {
        await gitWorktreeRemove({
          projectPath: project.path,
          worktreePath: worktree.path,
          force: true,
        });
        applyRemoval();
        return;
      } catch (e2) {
        deps.worktreePrompts.notifyFailure(String(e2));
        return;
      }
    }
    if (msg.includes("worktree not tracked")) {
      if (!(await deps.worktreePrompts.promptOrphanCleanup())) return;
      try {
        await gitWorktreeRemoveOrphan({
          projectPath: project.path,
          worktreePath: worktree.path,
        });
        applyRemoval();
        return;
      } catch (e2) {
        deps.worktreePrompts.notifyFailure(String(e2));
        return;
      }
    }
    deps.worktreePrompts.notifyFailure(msg);
  }
}
