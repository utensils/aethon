import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatAttachment } from "../types/a2ui";
import type { ProjectsState } from "../projects";
import type { NotificationInput } from "./useNotifications";
import { makeEmptyTab, type GitHubIssueSource, type Tab } from "../types/tab";
import { modelForNewProjectTab } from "./tabOps/helpers";
import {
  devshellNeedsPreparation,
  initialDevshellTerminalBuffer,
} from "./tabOps/devshellTerminal";
import {
  projectScopeBucketKey,
  workspaceIdForCwd,
} from "./projectOps/tabBuckets";
import type { TabBucket } from "./projectOps/types";

export interface StartTaskOptions {
  projectId: string;
  prompt: string;
  attachments?: ChatAttachment[];
  newWorkspace?: boolean;
  branch?: string;
  baseBranch?: string;
  workspaceId?: string;
  /** When false, create the task tab without switching the visible
   *  project/workspace or focusing the new tab. */
  activate?: boolean;
  /** Optional tab label for agent-launched/background tasks. */
  label?: string;
  /** Model the launched session should use (task-launcher model chip).
   *  Overrides the global default + per-project memory for this launch. */
  model?: string;
  /** Optional hidden prompt sent to the bridge while `prompt` remains the
   *  visible/local-history text. Used when agent-side launchers need to pass
   *  deterministic context without polluting the chat transcript. */
  bridgePrompt?: string;
  sourceIssue?: GitHubIssueSource;
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
    activate?: boolean;
  }) => Promise<string | null>;
  activateWorkspace: (workspaceId: string | null) => void;
  newTab: (
    restoreId?: string,
    restoreLabel?: string,
    options?: {
      restoredSession?: boolean;
      cwd?: string;
      hostId?: string;
      scrollToMatch?: string;
      model?: string;
      sourceIssue?: GitHubIssueSource;
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
  setState?: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef?: MutableRefObject<Record<string, unknown>>;
  tabBucketsRef?: MutableRefObject<Map<string, TabBucket>>;
  piDefaultModelRef?: MutableRefObject<string>;
  prepareWorkspaceStartup?: (cwd: string) => Promise<boolean>;
}

export interface StartTaskResult {
  tabId: string;
  projectId: string;
  cwd: string;
  activated: boolean;
}

function mirrorPersistedBuckets(
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>,
  activeBucketKey: string,
): Record<string, TabBucket> {
  const persisted: Record<string, TabBucket> = {};
  for (const [key, bucket] of tabBucketsRef.current.entries()) {
    if (key === activeBucketKey) continue;
    persisted[key] = {
      tabs: bucket.tabs,
      activeTabId: bucket.activeTabId,
    };
  }
  return persisted;
}

function countKnownTabs(
  stateRef: MutableRefObject<Record<string, unknown>>,
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>,
  activeBucketKey: string,
): number {
  const ids = new Set<string>();
  for (const tab of (stateRef.current.tabs as Tab[] | undefined) ?? []) {
    ids.add(tab.id);
  }
  for (const [bucketKey, bucket] of tabBucketsRef.current.entries()) {
    if (bucketKey === activeBucketKey) continue;
    for (const tab of bucket.tabs) ids.add(tab.id);
  }
  return ids.size;
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
  setState,
  stateRef,
  tabBucketsRef,
  piDefaultModelRef,
  prepareWorkspaceStartup,
}: UseTaskLauncherOptions): (opts: StartTaskOptions) => Promise<StartTaskResult | void> {
  return useCallback(
    async (opts: StartTaskOptions): Promise<StartTaskResult | void> => {
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
      const shouldActivate = opts.activate !== false;
      if (shouldActivate && projectsRef.current.activeId !== opts.projectId) {
        setActiveProjectById(opts.projectId);
      }
      let cwd = project.path;
      let workspaceIdForBucket: string | null | undefined = null;
      let workspaceBranch: string | undefined;
      if (opts.newWorkspace) {
        const branch = (opts.branch ?? "").trim();
        const created = await createWorkspaceWithParams({
          projectId: opts.projectId,
          ...(branch ? { branch } : {}),
          baseBranch: opts.baseBranch,
          activate: shouldActivate,
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
        workspaceIdForBucket = createdWorkspace?.id ?? null;
        workspaceBranch = (createdWorkspace?.branch ?? branch) || undefined;
        if (shouldActivate && createdWorkspace)
          activateWorkspace(createdWorkspace.id);
      } else if (opts.workspaceId) {
        const list =
          projectsRef.current.workspacesByProject[opts.projectId] ?? [];
        const wt = list.find((w) => w.id === opts.workspaceId);
        if (wt) {
          cwd = wt.path;
          workspaceIdForBucket = wt.id;
          workspaceBranch = wt.branch ?? undefined;
          if (shouldActivate) activateWorkspace(wt.id);
        }
      }
      const tabId = crypto.randomUUID();
      const sourceIssue = opts.sourceIssue
        ? {
            ...opts.sourceIssue,
            branch: workspaceBranch ?? opts.branch ?? opts.sourceIssue.branch,
            ...(workspaceIdForBucket ? { workspaceId: workspaceIdForBucket } : {}),
            workspacePath: cwd,
          }
        : undefined;
      if (shouldActivate || !setState || !stateRef || !tabBucketsRef) {
        newTab(tabId, opts.label, {
          cwd,
          ...(opts.model ? { model: opts.model } : {}),
          ...(sourceIssue ? { sourceIssue } : {}),
        });
      } else {
        const activeBucketKey = projectScopeBucketKey(
          projectsRef.current.activeId,
          projectsRef.current.activeWorkspaceId,
        );
        const targetWorkspaceId =
          workspaceIdForBucket ??
          workspaceIdForCwd(projectsRef.current, cwd, opts.projectId) ??
          null;
        const targetBucketKey = projectScopeBucketKey(
          opts.projectId,
          targetWorkspaceId,
        );
        const inheritedModel = modelForNewProjectTab(
          stateRef.current,
          opts.projectId,
          piDefaultModelRef?.current ?? "",
          opts.model,
        );
        const inheritedThinkingLevel =
          typeof stateRef.current.defaultThinkingLevel === "string"
            ? stateRef.current.defaultThinkingLevel
            : undefined;
        const initialTerminalBuffer = initialDevshellTerminalBuffer(
          stateRef.current,
          cwd,
        );
        const preparingDevshell = devshellNeedsPreparation(
          stateRef.current,
          cwd,
        );
        const tab: Tab = {
          ...makeEmptyTab(
            tabId,
            opts.label ??
              `Tab ${countKnownTabs(stateRef, tabBucketsRef, activeBucketKey) + 1}`,
            opts.projectId,
          ),
          model: inheritedModel,
          terminalBuffer: initialTerminalBuffer,
          waiting: preparingDevshell,
          ...(inheritedThinkingLevel
            ? { thinkingLevel: inheritedThinkingLevel }
            : {}),
          cwd,
          ...(sourceIssue ? { sourceIssue } : {}),
        };
        if (targetBucketKey === activeBucketKey) {
          setState((prev) => {
            const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
            tabs.push(tab);
            return {
              ...prev,
              tabs,
              empty: false,
              hasTabs: true,
            };
          });
        } else {
          const existing = tabBucketsRef.current.get(targetBucketKey);
          const bucket: TabBucket = {
            tabs: [...(existing?.tabs ?? []), tab],
            activeTabId: tab.id,
          };
          tabBucketsRef.current.set(targetBucketKey, bucket);
          setState((prev) => ({
            ...prev,
            persistedTabBuckets: mirrorPersistedBuckets(
              tabBucketsRef,
              activeBucketKey,
            ),
          }));
        }
        const opening = (async () => {
          if (cwd) {
            const ready = prepareWorkspaceStartup
              ? await prepareWorkspaceStartup(cwd)
              : await invoke<{ state?: string }>(
                  "workspace_startup_prepare_for_path",
                  { args: { cwd } },
                ).then((status) =>
                  ["ready", "continued", "disabled"].includes(
                    status?.state ?? "ready",
                  ),
                );
            if (!ready) throw new Error("workspace startup not ready");
            setState((prev) => {
              const clearWaiting = (candidate: Tab): Tab =>
                candidate.id === tabId && candidate.waiting === true
                  ? { ...candidate, waiting: false }
                  : candidate;
              const tabs = ((prev.tabs as Tab[] | undefined) ?? []).map(
                clearWaiting,
              );
              const bucket = tabBucketsRef.current.get(targetBucketKey);
              if (bucket) {
                tabBucketsRef.current.set(targetBucketKey, {
                  ...bucket,
                  tabs: bucket.tabs.map(clearWaiting),
                });
              }
              return {
                ...prev,
                tabs,
                persistedTabBuckets: mirrorPersistedBuckets(
                  tabBucketsRef,
                  activeBucketKey,
                ),
              };
            });
          }
          return await invoke("agent_command", {
            payload: JSON.stringify({
              type: "tab_open",
              tabId,
              ...(inheritedModel ? { model: inheritedModel } : {}),
              ...(inheritedThinkingLevel
                ? { thinkingLevel: inheritedThinkingLevel }
                : {}),
              cwd,
            }),
          });
        })();
        pendingTabOpens.current.set(tabId, opening);
        opening
          .catch((err) => {
            pushNotificationRef.current({
              title: "Could not start task",
              message: `Failed to open background tab: ${err}`,
              kind: "warning",
            });
          })
          .finally(() => {
            pendingTabOpens.current.delete(tabId);
          });
      }
      const opening = pendingTabOpens.current.get(tabId);
      let opened = true;
      if (opening) {
        try {
          await opening;
        } catch {
          opened = false;
        }
      }
      if (!opened) return;
      const trimmed = opts.prompt.trim();
      if (trimmed || (opts.attachments?.length ?? 0) > 0) {
        await sendChat(trimmed, {
          tabId,
          ...(opts.attachments ? { attachments: opts.attachments } : {}),
          ...(opts.bridgePrompt ? { bridgeText: opts.bridgePrompt } : {}),
        });
      }
      return { tabId, projectId: opts.projectId, cwd, activated: shouldActivate };
    },
    [
      activateWorkspace,
      createWorkspaceWithParams,
      newTab,
      pendingTabOpens,
      piDefaultModelRef,
      prepareWorkspaceStartup,
      projectsRef,
      pushNotificationRef,
      sendChat,
      setActiveProjectById,
      setState,
      stateRef,
      tabBucketsRef,
    ],
  );
}
