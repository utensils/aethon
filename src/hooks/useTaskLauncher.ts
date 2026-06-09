import { useCallback, type MutableRefObject } from "react";
import type { ChatAttachment } from "../types/a2ui";
import type { ProjectsState } from "../projects";
import type { NotificationInput } from "./useNotifications";

export interface StartTaskOptions {
  projectId: string;
  prompt: string;
  attachments?: ChatAttachment[];
  newWorkspace?: boolean;
  branch?: string;
  baseBranch?: string;
  workspaceId?: string;
  /** Model the launched session should use (task-launcher model chip).
   *  Overrides the global default + per-project memory for this launch. */
  model?: string;
  /** Optional hidden prompt sent to the bridge while `prompt` remains the
   *  visible/local-history text. Used when agent-side launchers need to pass
   *  deterministic context without polluting the chat transcript. */
  bridgePrompt?: string;
}

export interface UseTaskLauncherOptions {
  projectsRef: MutableRefObject<ProjectsState>;
  pushNotificationRef: MutableRefObject<(n: NotificationInput) => void>;
  setActiveProjectById: (id: string) => boolean;
  createWorkspaceWithParams: (opts: {
    projectId: string;
    branch?: string;
    targetPath?: string;
    baseBranch?: string;
  }) => Promise<string | null>;
  activateWorkspace: (workspaceId: string | null) => void;
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
    options?: {
      tabId?: string;
      attachments?: ChatAttachment[];
      bridgeText?: string;
    },
  ) => Promise<void>;
}

export function useTaskLauncher({
  projectsRef,
  pushNotificationRef,
  setActiveProjectById,
  createWorkspaceWithParams,
  activateWorkspace,
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
      if (opts.newWorkspace) {
        const branch = (opts.branch ?? "").trim();
        const created = await createWorkspaceWithParams({
          projectId: opts.projectId,
          ...(branch ? { branch } : {}),
          baseBranch: opts.baseBranch,
        });
        if (!created) {
          pushNotificationRef.current({
            title: "Workspace create failed",
            message: branch
              ? `Could not create '${branch}'. See the sidebar's pending row for details.`
              : "Could not create an automatic workspace. See the sidebar's pending row for details.",
            kind: "warning",
          });
          return;
        }
        cwd = created;
        const createdWorkspace =
          projectsRef.current.workspacesByProject[opts.projectId]?.find(
            (w) => w.path === created,
          );
        if (createdWorkspace) activateWorkspace(createdWorkspace.id);
      } else if (opts.workspaceId) {
        const list =
          projectsRef.current.workspacesByProject[opts.projectId] ?? [];
        const wt = list.find((w) => w.id === opts.workspaceId);
        if (wt) {
          cwd = wt.path;
          activateWorkspace(wt.id);
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
        await sendChat(trimmed, {
          tabId,
          ...(opts.attachments ? { attachments: opts.attachments } : {}),
          ...(opts.bridgePrompt ? { bridgeText: opts.bridgePrompt } : {}),
        });
      }
    },
    [
      activateWorkspace,
      createWorkspaceWithParams,
      newTab,
      pendingTabOpens,
      projectsRef,
      pushNotificationRef,
      sendChat,
      setActiveProjectById,
    ],
  );
}
