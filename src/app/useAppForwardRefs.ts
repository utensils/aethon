import { useEffect, type MutableRefObject } from "react";
import type {
  ChatActionsHandle,
  ProjectOpsHandle,
  ProjectsHandle,
} from "../hooks/useAppStateRefs";
import type { NotificationInput } from "../hooks/useNotifications";
import type { ProjectsState } from "../projects";

export interface UseAppForwardRefsContext {
  // Backing refs (from useAppStateRefs). These are the slots downstream
  // consumers dereference; the hook below writes the live values into
  // them on every commit.
  projectOpsHandleRef: MutableRefObject<ProjectOpsHandle>;
  projectsHandleRef: MutableRefObject<ProjectsHandle>;
  projectsRef: MutableRefObject<ProjectsState>;
  pushNotificationRef: MutableRefObject<(n: NotificationInput) => void>;
  chatActionsRef: MutableRefObject<ChatActionsHandle>;

  // Live values to mirror into the refs above. Wired into the producing
  // hooks (useProjectOps, useNotifications, useChat) at the App.tsx
  // composition site.
  clearActiveProject: () => void;
  setActiveProjectById: (id: string) => boolean;
  syncProjectsToState: () => void;
  pushNotification: (n: NotificationInput) => string;
  appendMessage: ChatActionsHandle["appendMessage"];
  appendSystem: ChatActionsHandle["appendSystem"];
  clearChat: ChatActionsHandle["clearChat"];
  setModel: ChatActionsHandle["setModel"];
}

/** Mirror the live functions produced by later hooks into the forward
 *  refs that earlier hooks closed over.
 *
 *  Several App hooks (`useTabs`, `useShellConsent`, `useZoomAndTheme`,
 *  `useExtensionsHydration`) need to invoke functions that aren't yet
 *  defined when they mount — chat append, project clear, notifications.
 *  The producers (`useChat`, `useProjectOps`, `useNotifications`) come
 *  later in the call order. The well-known workaround is a ref-slot:
 *  the early hook closes over `someRef.current(args)`, and we write the
 *  real function into the slot in a commit-phase `useEffect` once it
 *  exists. No dependency array — every commit re-mirrors, so a hook
 *  output that re-identifies between renders stays in sync.
 *
 *  All three wires share that pattern and run after every commit, so
 *  consolidating them here makes the indirection visible in one place
 *  instead of three. */
export function useAppForwardRefs(ctx: UseAppForwardRefsContext): void {
  const {
    projectOpsHandleRef,
    projectsHandleRef,
    projectsRef,
    pushNotificationRef,
    chatActionsRef,
    clearActiveProject,
    setActiveProjectById,
    syncProjectsToState,
    pushNotification,
    appendMessage,
    appendSystem,
    clearChat,
    setModel,
  } = ctx;

  useEffect(() => {
    projectOpsHandleRef.current = {
      clearActiveProject,
      setActiveProjectById,
    };
    projectsHandleRef.current = {
      getPaths: () => projectsRef.current.projects.map((p) => p.path),
      onGitStatusChanged: () => syncProjectsToState(),
    };
    pushNotificationRef.current = pushNotification;
    chatActionsRef.current = {
      appendMessage,
      appendSystem,
      clearChat,
      setModel,
    };
  });
}
