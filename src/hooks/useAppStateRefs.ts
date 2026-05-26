import { useEffect, useRef, type MutableRefObject } from "react";
import type { ChatMessage } from "../types/a2ui";
import { emptyProjectsState, type ProjectsState } from "../projects";
import type { AppStore } from "../state/appStore";
import type { NotificationInput } from "./useNotifications";

export interface ProjectOpsHandle {
  clearActiveProject: () => void;
  setActiveProjectById: (id: string) => boolean;
}

export interface ProjectsHandle {
  getPaths: () => string[];
  onGitStatusChanged: () => void;
}

export interface ChatActionsHandle {
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  appendSystem: (text: string) => void;
  clearChat: () => void;
  setModel: (id: string) => Promise<void>;
}

export interface AppStateRefs {
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  piDefaultModelRef: MutableRefObject<string>;
  hangWarnActiveRef: MutableRefObject<Set<string>>;
  hangWarnTimersRef: MutableRefObject<
    Map<string, ReturnType<typeof setTimeout>>
  >;
  projectOpsHandleRef: MutableRefObject<ProjectOpsHandle>;
  projectsHandleRef: MutableRefObject<ProjectsHandle>;
  pushNotificationRef: MutableRefObject<(n: NotificationInput) => void>;
  chatActionsRef: MutableRefObject<ChatActionsHandle>;
}

export function useAppStateRefs(appStore: AppStore): AppStateRefs {
  const stateRef = useRef(appStore.getState());
  useEffect(() => {
    stateRef.current = appStore.getState();
    return appStore.subscribe(() => {
      stateRef.current = appStore.getState();
    });
  }, [appStore]);

  return {
    stateRef,
    projectsRef: useRef<ProjectsState>(emptyProjectsState()),
    piDefaultModelRef: useRef<string>(""),
    hangWarnActiveRef: useRef<Set<string>>(new Set()),
    hangWarnTimersRef: useRef<Map<string, ReturnType<typeof setTimeout>>>(
      new Map(),
    ),
    projectOpsHandleRef: useRef<ProjectOpsHandle>({
      clearActiveProject: () => {},
      setActiveProjectById: () => false,
    }),
    projectsHandleRef: useRef<ProjectsHandle>({
      getPaths: () => [],
      onGitStatusChanged: () => {},
    }),
    pushNotificationRef: useRef<(n: NotificationInput) => void>(() => {}),
    chatActionsRef: useRef<ChatActionsHandle>({
      appendMessage: () => {},
      appendSystem: () => {},
      clearChat: () => {},
      setModel: async () => {},
    }),
  };
}
