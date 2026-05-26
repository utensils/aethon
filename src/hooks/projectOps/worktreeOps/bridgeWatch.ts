import type { Project } from "../../../projects";

interface BridgeWatchDeps {
  watchProjectForBridge: (path: string) => void;
  unwatchProjectForBridge: (path: string) => void;
}

/**
 * When activating a worktree crosses project boundaries, swap the
 * bridge file-watch from the previous project root to the next one.
 * Caller owns the decision to invoke this — see activateWorktree.
 */
export function swapProjectWatch(
  previousActive: Project | null,
  nextProjectPath: string | null,
  deps: BridgeWatchDeps,
): void {
  if (!previousActive || !nextProjectPath) return;
  if (previousActive.path === nextProjectPath) return;
  deps.unwatchProjectForBridge(previousActive.path);
  deps.watchProjectForBridge(nextProjectPath);
}
