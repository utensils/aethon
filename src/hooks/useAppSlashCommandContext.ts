import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { A2UIPayload, ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";
import { activeProject, type ProjectsState } from "../projects";
import { durableImageAttachments } from "../utils/imageAttachments";
import { trimMessage } from "../utils/messages";
import type { SlashCommandContext } from "../slashCommands";
import type { ExtensionRegistry } from "../extensions/ExtensionRegistry";
import type { LayoutCatalogueEntry } from "../extensions/default-layout";
import type { NotificationInput } from "./useNotifications";
import type { AuthProfilesUiState } from "../auth-profiles";
import {
  cancelScheduledTask,
  createScheduledTask,
  listScheduledTasks,
  pauseScheduledTask,
  resolveLoopPrompt,
  resumeScheduledTask,
  runScheduledTaskNow,
  type ScheduledTaskMode,
  type ScheduledTaskRecord,
  type ScheduledTaskSchedule,
} from "../scheduledTasks";

export interface UseAppSlashCommandContextOptions {
  bootLayout: A2UIPayload;
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  setLayout: Dispatch<SetStateAction<A2UIPayload>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  layoutCatalogueRef: MutableRefObject<LayoutCatalogueEntry[]>;
  registry: ExtensionRegistry;
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  pushNotification: (n: NotificationInput) => string;
  clearChat: () => void;
  setTheme: (id: string) => void;
  listThemes: () => { id: string; label: string }[];
  setModel: (id: string) => Promise<void>;
  toggleTerminal: () => void;
  toggleSidebar: () => void;
  toggleFilesSidebar: () => void;
  activateLayoutById: (id: string) => boolean;
  openProjectFromPicker: () => Promise<string | null>;
  openProjectByPath: (path: string, label?: string) => string;
  setActiveProjectById: (id: string) => boolean;
  clearActiveProject: () => void;
  removeProjectById: (id: string) => boolean;
}

export interface AppSlashCommandContextResult {
  slashContext: () => SlashCommandContext;
  persistLocalChatMessage: (msg: ChatMessage, tabId: string) => void;
}

export function useAppSlashCommandContext({
  bootLayout,
  setState,
  setLayout,
  stateRef,
  projectsRef,
  layoutCatalogueRef,
  registry,
  appendMessage,
  pushNotification,
  clearChat,
  setTheme,
  listThemes,
  setModel,
  toggleTerminal,
  toggleSidebar,
  toggleFilesSidebar,
  activateLayoutById,
  openProjectFromPicker,
  openProjectByPath,
  setActiveProjectById,
  clearActiveProject,
  removeProjectById,
}: UseAppSlashCommandContextOptions): AppSlashCommandContextResult {
  const persistLocalChatMessage = useCallback(
    (msg: ChatMessage, tabId: string) => {
      const durableMessage = trimMessage(msg);
      const attachments = durableImageAttachments(durableMessage.attachments);
      const a2ui = Array.isArray(durableMessage.a2ui?.components)
        ? durableMessage.a2ui
        : undefined;
      if (
        !durableMessage.text &&
        !durableMessage.thinking &&
        !a2ui &&
        attachments.length === 0
      ) {
        return;
      }
      invoke("agent_command", {
        payload: JSON.stringify({
          type: "local_chat_message",
          tabId,
          payload: {
            id: durableMessage.id,
            role: durableMessage.role,
            ...(durableMessage.text ? { text: durableMessage.text } : {}),
            ...(durableMessage.thinking
              ? { thinking: durableMessage.thinking }
              : {}),
            ...(durableMessage.delivery
              ? { delivery: durableMessage.delivery }
              : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(a2ui ? { a2ui } : {}),
            createdAt:
              typeof durableMessage.createdAt === "number" &&
              Number.isFinite(durableMessage.createdAt)
                ? durableMessage.createdAt
                : Date.now(),
          },
        }),
      }).catch(() => {
        /* bridge gone — visible state remains in-memory until reload */
      });
    },
    [],
  );

  const slashContext = useCallback(
    (): SlashCommandContext => ({
      appendSystem: (text: string) => {
        const tabId =
          (stateRef.current.activeTabId as string | undefined) ?? "default";
        const msg = { id: crypto.randomUUID(), role: "system" as const, text };
        appendMessage(msg, tabId);
        persistLocalChatMessage(msg, tabId);
      },
      notify: (input) => {
        pushNotification(input);
      },
      clearChat,
      setTheme,
      listThemes,
      setModel,
      setPlanMode: (enabled: boolean) => {
        const activeId = stateRef.current.activeTabId;
        if (typeof activeId !== "string" || activeId.length === 0) return;
        setState((prev) => {
          const tabs = (prev.tabs as Tab[] | undefined) ?? [];
          const idx = tabs.findIndex((t) => t.id === activeId);
          if (idx < 0 || tabs[idx].kind !== "agent") return prev;
          const next = [...tabs];
          next[idx] = { ...next[idx], planMode: enabled };
          return {
            ...prev,
            tabs: next,
            ...(prev.activeTabId === activeId ? { planMode: enabled } : {}),
          };
        });
      },
      getPlanMode: () => {
        const activeId = stateRef.current.activeTabId;
        const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
        const tab = tabs.find((t) => t.id === activeId);
        return tab?.kind === "agent" ? tab.planMode === true : false;
      },
      resetLayout: () => setLayout(bootLayout),
      listExtensions: () => registry.list().map((s) => s.name),
      installExtension: async (spec: string) => {
        return await invoke<string>("install_aethon_extension", { spec });
      },
      listModels: () => {
        const sidebar =
          (stateRef.current.sidebar as Record<string, unknown>) ?? {};
        return (
          (sidebar.models as {
            id: string;
            label: string;
            active?: boolean;
          }[]) ?? []
        );
      },
      openLogin: () => {
        setState((prev) => ({
          ...prev,
          authProfiles: {
            profiles: [],
            defaultByProvider: {},
            providers: [],
            activeByTab: {},
            ...(prev.authProfiles ?? {}),
            modal: { open: true },
          },
        }));
        void invoke("agent_command", {
          payload: JSON.stringify({ type: "auth_profiles_list" }),
        });
      },
      listAuthProfiles: () => {
        const auth =
          (stateRef.current.authProfiles as AuthProfilesUiState | undefined) ??
          undefined;
        const activeId = stateRef.current.activeTabId as string | undefined;
        return (auth?.profiles ?? []).map((p) => ({
          id: p.id,
          label: p.label,
          providerId: p.providerId,
          kind: p.kind,
          active: !!activeId && auth?.activeByTab?.[activeId] === p.id,
          default: auth?.defaultByProvider?.[p.providerId] === p.id,
        }));
      },
      useAuthProfile: async (idOrLabel: string) => {
        const auth =
          (stateRef.current.authProfiles as AuthProfilesUiState | undefined) ??
          undefined;
        const profile = (auth?.profiles ?? []).find(
          (p) => p.id === idOrLabel || p.label === idOrLabel,
        );
        if (!profile) throw new Error(`Unknown account: ${idOrLabel}`);
        const activeId = stateRef.current.activeTabId;
        await invoke("agent_command", {
          payload: JSON.stringify({
            type: "auth_profile_use_for_tab",
            tabId:
              typeof activeId === "string" && activeId.length > 0
                ? activeId
                : "default",
            profileId: profile.id,
          }),
        });
      },
      setDefaultAuthProfile: async (idOrLabel: string) => {
        const auth =
          (stateRef.current.authProfiles as AuthProfilesUiState | undefined) ??
          undefined;
        const profile = (auth?.profiles ?? []).find(
          (p) => p.id === idOrLabel || p.label === idOrLabel,
        );
        if (!profile) throw new Error(`Unknown account: ${idOrLabel}`);
        await invoke("agent_command", {
          payload: JSON.stringify({
            type: "auth_profile_set_default",
            profileId: profile.id,
          }),
        });
      },
      toggleTerminal,
      toggleSidebar,
      toggleFilesSidebar,
      activateLayout: activateLayoutById,
      listLayouts: () =>
        layoutCatalogueRef.current.map((l) => ({
          id: l.id,
          name: l.name,
          description: l.description,
        })),
      pickProject: openProjectFromPicker,
      openProject: (path: string, label?: string) =>
        openProjectByPath(path, label),
      setActiveProject: setActiveProjectById,
      clearProject: clearActiveProject,
      removeProject: removeProjectById,
      listProjects: () =>
        projectsRef.current.projects.map((p) => ({
          id: p.id,
          label: p.label,
          path: p.path,
        })),
      reloadAgent: async () => {
        await invoke("reload_agent");
      },
      runNativeCommand: async (name: string, args: string) => {
        const activeId = stateRef.current.activeTabId;
        const tabId =
          typeof activeId === "string" && activeId.length > 0
            ? activeId
            : "default";
        await invoke("agent_command", {
          payload: JSON.stringify({
            type: "native_slash_command",
            tabId,
            name,
            args,
          }),
        });
      },
      renameSession: async (tabId: string, label: string) => {
        setState((prev) => {
          const tabs = (prev.tabs as Tab[] | undefined) ?? [];
          const idx = tabs.findIndex((t) => t.id === tabId);
          if (idx < 0) return prev;
          const trimmed = label.trim();
          const fallback = `Tab ${idx + 1}`;
          const nextLabel = trimmed.length > 0 ? trimmed : fallback;
          if (tabs[idx].label === nextLabel) return prev;
          const next = [...tabs];
          next[idx] = { ...next[idx], label: nextLabel };
          return { ...prev, tabs: next };
        });
        await invoke("agent_command", {
          payload: JSON.stringify({
            type: "set_session_label",
            tabId,
            label,
          }),
        });
      },
      openScheduledTasks: () => {
        setState((prev) => ({
          ...prev,
          scheduledTasks: {
            ...(prev.scheduledTasks ?? {}),
            open: true,
          },
        }));
      },
      createScheduledTask: async (input: {
        mode: ScheduledTaskMode;
        schedule: ScheduledTaskSchedule;
        prompt: string;
        label?: string;
        promptSource?: string;
      }): Promise<ScheduledTaskRecord> => {
        const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
        const activeId = stateRef.current.activeTabId;
        const tab = tabs.find((t) => t.id === activeId);
        if (!tab || tab.kind !== "agent") {
          throw new Error("Open an agent tab before creating a scheduled task.");
        }
        const project = activeProject(projectsRef.current);
        const cwd =
          tab.cwd ??
          project?.path ??
          (await invoke<string>("aethon_home_dir").catch(() => ""));
        if (!cwd) throw new Error("Could not resolve a working directory.");
        let prompt = input.prompt.trim();
        let promptSource = input.promptSource ?? "inline";
        if (!prompt) {
          const resolved = await resolveLoopPrompt(cwd);
          prompt = resolved.prompt;
          promptSource = resolved.source;
        }
        const created = await createScheduledTask({
          tabId: tab.id,
          cwd,
          model: tab.model || null,
          thinkingLevel: tab.thinkingLevel ?? null,
          hardEnforce: tab.hardEnforceProjectRoot ?? null,
          authProfileId: tab.authProfileId ?? null,
          label: input.label ?? null,
          prompt,
          visiblePrompt: prompt,
          promptSource,
          mode: input.mode,
          schedule: input.schedule,
        });
        setState((prev) => {
          const cur =
            (prev.scheduledTasks as
              | { tasks?: ScheduledTaskRecord[] }
              | undefined) ?? {};
          return {
            ...prev,
            scheduledTasks: {
              ...cur,
              tasks: [
                created,
                ...(cur.tasks ?? []).filter((task) => task.id !== created.id),
              ],
            },
          };
        });
        return created;
      },
      listScheduledTasks,
      runScheduledTask: runScheduledTaskNow,
      pauseScheduledTask,
      resumeScheduledTask,
      cancelScheduledTask,
      activeTabId: () => {
        const id = stateRef.current.activeTabId;
        return typeof id === "string" && id.length > 0 ? id : null;
      },
      activeProject: () => {
        const a = activeProject(projectsRef.current);
        return a ? { id: a.id, label: a.label, path: a.path } : null;
      },
    }),
    [
      activateLayoutById,
      appendMessage,
      bootLayout,
      clearActiveProject,
      clearChat,
      layoutCatalogueRef,
      listThemes,
      openProjectByPath,
      openProjectFromPicker,
      persistLocalChatMessage,
      projectsRef,
      pushNotification,
      registry,
      removeProjectById,
      setActiveProjectById,
      setLayout,
      setModel,
      setState,
      setTheme,
      stateRef,
      toggleFilesSidebar,
      toggleSidebar,
      toggleTerminal,
    ],
  );

  return { slashContext, persistLocalChatMessage };
}
