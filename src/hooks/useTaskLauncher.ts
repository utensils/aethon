import { useCallback, type MutableRefObject } from "react";
import type { ChatAttachment } from "../types/a2ui";
import type { ProjectsState } from "../projects";
import type { NotificationInput } from "./useNotifications";

export interface StartTaskOptions {
  projectId: string;
  prompt: string;
  attachments?: ChatAttachment[];
  newWorktree?: boolean;
  branch?: string;
  baseBranch?: string;
  worktreeId?: string;
  /** Model the launched session should use (task-launcher model chip).
   *  Overrides the global default + per-project memory for this launch. */
  model?: string;
}

export interface UseTaskLauncherOptions {
  projectsRef: MutableRefObject<ProjectsState>;
  pushNotificationRef: MutableRefObject<(n: NotificationInput) => void>;
  setActiveProjectById: (id: string) => boolean;
  createWorktreeWithParams: (opts: {
    projectId: string;
    branch?: string;
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
      model?: string;
    },
  ) => void;
  pendingTabOpens: MutableRefObject<Map<string, Promise<unknown>>>;
  sendChat: (
    text: string,
    options?: { tabId?: string; attachments?: ChatAttachment[] },
  ) => Promise<void>;
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
        const created = await createWorktreeWithParams({
          projectId: opts.projectId,
          ...(branch ? { branch } : {}),
          baseBranch: opts.baseBranch,
        });
        if (!created) {
          pushNotificationRef.current({
            title: "Worktree create failed",
            message: branch
              ? `Could not create '${branch}'. See the sidebar's pending row for details.`
              : "Could not create an automatic worktree. See the sidebar's pending row for details.",
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
      newTab(tabId, undefined, {
        cwd,
        ...(opts.model ? { model: opts.model } : {}),
      });
      const opening = pendingTabOpens.current.get(tabId);
      if (opening) {
        try {
          await opening;
        } catch {
          /* tab open failed; sendChat below will no-op */
        }
      }
      const trimmed = opts.prompt.trim();
      if (trimmed || (opts.attachments?.length ?? 0) > 0) {
        await sendChat(trimmed, { tabId, attachments: opts.attachments });
      }
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
