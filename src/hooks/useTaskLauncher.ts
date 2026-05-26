import { useCallback, type MutableRefObject } from "react";
import type { ProjectsState } from "../projects";
import type { NotificationInput } from "./useNotifications";

export interface StartTaskOptions {
  projectId: string;
  prompt: string;
  newWorktree?: boolean;
  branch?: string;
  baseBranch?: string;
  worktreeId?: string;
}

export interface UseTaskLauncherOptions {
  projectsRef: MutableRefObject<ProjectsState>;
  pushNotificationRef: MutableRefObject<(n: NotificationInput) => void>;
  setActiveProjectById: (id: string) => boolean;
  createWorktreeWithParams: (opts: {
    projectId: string;
    branch: string;
    targetPath?: string;
    baseBranch?: string;
  }) => Promise<string | null>;
  activateWorktree: (worktreeId: string | null) => void;
  newTab: (
    restoreId?: string,
    restoreLabel?: string,
    options?: {
      restoredSession?: boolean;
      cwd?: string;
      scrollToMatch?: string;
    },
  ) => void;
  pendingTabOpens: MutableRefObject<Map<string, Promise<unknown>>>;
  sendChat: (text: string, options?: { tabId?: string }) => Promise<void>;
}

export function useTaskLauncher({
  projectsRef,
  pushNotificationRef,
  setActiveProjectById,
  createWorktreeWithParams,
  activateWorktree,
  newTab,
  pendingTabOpens,
  sendChat,
}: UseTaskLauncherOptions): (opts: StartTaskOptions) => Promise<void> {
  return useCallback(
    async (opts: StartTaskOptions): Promise<void> => {
      const project = projectsRef.current.projects.find(
        (p) => p.id === opts.projectId,
      );
      if (!project) {
        pushNotificationRef.current({
          title: "Could not start task",
          message: "Project no longer exists.",
          kind: "warning",
        });
        return;
      }
      if (projectsRef.current.activeId !== opts.projectId) {
        setActiveProjectById(opts.projectId);
      }
      let cwd = project.path;
      if (opts.newWorktree) {
        const branch = (opts.branch ?? "").trim();
        if (!branch) {
          pushNotificationRef.current({
            title: "New worktree needs a branch name",
            message: "Enter a branch name in the launcher before starting.",
            kind: "warning",
          });
          return;
        }
        const created = await createWorktreeWithParams({
          projectId: opts.projectId,
          branch,
          baseBranch: opts.baseBranch,
        });
        if (!created) {
          pushNotificationRef.current({
            title: "Worktree create failed",
            message: `Could not create '${branch}'. See the sidebar's pending row for details.`,
            kind: "warning",
          });
          return;
        }
        cwd = created;
        const createdWorktree =
          projectsRef.current.worktreesByProject[opts.projectId]?.find(
            (w) => w.path === created,
          );
        if (createdWorktree) activateWorktree(createdWorktree.id);
      } else if (opts.worktreeId) {
        const list =
          projectsRef.current.worktreesByProject[opts.projectId] ?? [];
        const wt = list.find((w) => w.id === opts.worktreeId);
        if (wt) {
          cwd = wt.path;
          activateWorktree(wt.id);
        }
      }
      const tabId = crypto.randomUUID();
      newTab(tabId, undefined, { cwd });
      const opening = pendingTabOpens.current.get(tabId);
      if (opening) {
        try {
          await opening;
        } catch {
          /* tab open failed; sendChat below will no-op */
        }
      }
      const trimmed = opts.prompt.trim();
      if (trimmed) await sendChat(trimmed, { tabId });
    },
    [
      activateWorktree,
      createWorktreeWithParams,
      newTab,
      pendingTabOpens,
      projectsRef,
      pushNotificationRef,
      sendChat,
      setActiveProjectById,
    ],
  );
}
