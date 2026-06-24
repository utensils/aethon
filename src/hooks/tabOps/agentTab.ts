import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { makeEmptyTab, type GitHubIssueSource, type Tab } from "../../types/tab";
import type { ProjectsState } from "../../projects";
import { recomputeModelPicker } from "../../utils/modelPicker";
import { TAB_MIRROR_KEYS } from "./constants";
import {
  devshellNeedsPreparation,
  initialDevshellTerminalBuffer,
} from "./devshellTerminal";
import {
  cwdForNewTab,
  modelForNewProjectTab,
  sessionLabelFromMessages,
} from "./helpers";

export interface NewTabDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  piDefaultModelRef: MutableRefObject<string>;
  pendingTabOpens: MutableRefObject<Map<string, Promise<unknown>>>;
  appendSystem: (text: string) => void;
  dispatchTerminalReplay: (buffer: string) => void;
  prepareWorkspaceStartup?: (cwd: string) => Promise<boolean>;
}

/** Build the agent-tab creator. Owns the heavy lifting around restoring
 *  a tab by id (so the bridge's SessionManager.continueRecent picks up
 *  the persisted JSONL session for that id), inheriting model + cwd
 *  from project scope, and seeding a scroll-to-match target for the
 *  search-hit empty-state path. */
export function useNewTab(deps: NewTabDeps) {
  const {
    setState,
    stateRef,
    projectsRef,
    piDefaultModelRef,
    pendingTabOpens,
    appendSystem,
    dispatchTerminalReplay,
    prepareWorkspaceStartup,
  } = deps;

  return function newTab(
    restoreId?: string,
    restoreLabel?: string,
    options?: {
      restoredSession?: boolean;
      cwd?: string;
      scrollToMatch?: string;
      /** Per-launch model override (task-launcher model chip). Wins over
       *  the global default + per-project memory in modelForNewProjectTab. */
      model?: string;
      sourceIssue?: GitHubIssueSource;
    },
  ): void {
    // restoreId lets the caller open a tab with a specific tabId so the
    // bridge's SessionManager.continueRecent picks up the persisted
    // session for that id. Used by the empty-state's "Recent sessions"
    // list. Omitted for normal new-tab gestures (Cmd+T, +, menu).
    const id = restoreId ?? crypto.randomUUID();
    // Search-hit scroll target. Stored in /scrollToMatchByTab/<id> so
    // ChatHistory picks it up once the bridge replays messages. Null
    // out the entry after a few seconds so a user who scrolls away
    // doesn't keep getting yanked back.
    const scrollToMatch = options?.scrollToMatch;
    if (scrollToMatch) {
      setState((prev) => {
        const cur =
          (prev.scrollToMatchByTab as Record<string, string> | undefined) ?? {};
        return {
          ...prev,
          scrollToMatchByTab: { ...cur, [id]: scrollToMatch },
        };
      });
      window.setTimeout(() => {
        setState((prev) => {
          const cur =
            (prev.scrollToMatchByTab as Record<string, string> | undefined) ??
            {};
          if (!(id in cur)) return prev;
          const next = { ...cur };
          delete next[id];
          return { ...prev, scrollToMatchByTab: next };
        });
      }, 5000);
    }
    // Project-scoped model default: new tabs in a project should use
    // the last model selected in that project, then the visible/global
    // model, then pi's ready-reported default.
    const projectId = projectsRef.current.activeId;
    const inheritedCwd =
      options?.cwd ??
      cwdForNewTab(projectsRef.current, stateRef.current) ??
      undefined;
    const inheritedModel = modelForNewProjectTab(
      stateRef.current,
      projectId,
      piDefaultModelRef.current,
      options?.model,
    );
    const inheritedThinkingLevel =
      typeof stateRef.current.defaultThinkingLevel === "string"
        ? stateRef.current.defaultThinkingLevel
        : undefined;
    const initialTerminalBuffer = inheritedCwd
      ? initialDevshellTerminalBuffer(stateRef.current, inheritedCwd)
      : "";
    const preparingDevshell = inheritedCwd
      ? devshellNeedsPreparation(stateRef.current, inheritedCwd)
      : false;
    const existingSessionLabel = restoreId
      ? sessionLabelFromMessages(
          ((stateRef.current.tabs as Tab[] | undefined) ?? []).find(
            (t) => t.id === restoreId,
          )?.messages ?? [],
        )
      : undefined;
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const label =
        restoreLabel ?? existingSessionLabel ?? `Tab ${tabs.length + 1}`;
      const tab: Tab = {
        ...makeEmptyTab(id, label, projectId),
        model: inheritedModel,
        terminalBuffer: initialTerminalBuffer,
        waiting: preparingDevshell,
        ...(inheritedThinkingLevel
          ? { thinkingLevel: inheritedThinkingLevel }
          : {}),
        ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
        ...(options?.sourceIssue ? { sourceIssue: options.sourceIssue } : {}),
      };
      tabs.push(tab);
      const result: Record<string, unknown> = {
        ...prev,
        tabs,
        activeTabId: id,
        empty: false,
        hasTabs: true,
      };
      if (restoreId) {
        const closedIds = Array.isArray(prev.closedSessionIds)
          ? (prev.closedSessionIds as string[])
          : [];
        if (closedIds.includes(restoreId)) {
          result.closedSessionIds = closedIds.filter(
            (item) => item !== restoreId,
          );
        }
      }
      const tabRec = tab as unknown as Record<string, unknown>;
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = tabRec[key as string];
      }
      result.sidebar = recomputeModelPicker(
        prev.sidebar as Record<string, unknown> | undefined,
        tab.model,
      );
      return result;
    });
    // Clear the shared xterm so it doesn't keep showing the previous
    // tab's scrollback until the next switch / output event.
    dispatchTerminalReplay(initialTerminalBuffer);
    const opening = (async () => {
      if (inheritedCwd) {
        try {
          const ok = prepareWorkspaceStartup
            ? await prepareWorkspaceStartup(inheritedCwd)
            : await invoke<{ state?: string }>(
                "workspace_startup_prepare_for_path",
                {
                  args: { cwd: inheritedCwd },
                },
              ).then((prepared) =>
                ["ready", "continued", "disabled"].includes(
                  prepared?.state ?? "ready",
                ),
              );
          if (!ok) {
            return;
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          appendSystem(`Workspace startup blocked for ${inheritedCwd}: ${reason}`);
          return;
        } finally {
          setState((prev) => {
            const tabs = ((prev.tabs as Tab[] | undefined) ?? []).map((tab) =>
              tab.id === id && tab.waiting === true
                ? { ...tab, waiting: false }
                : tab,
            );
            const activeTabId = prev.activeTabId;
            return {
              ...prev,
              tabs,
              ...(activeTabId === id ? { waiting: false } : {}),
            };
          });
        }
      }
      return await invoke("agent_command", {
        payload: JSON.stringify({
          type: "tab_open",
          tabId: id,
          ...(inheritedModel ? { model: inheritedModel } : {}),
          ...(inheritedThinkingLevel
            ? { thinkingLevel: inheritedThinkingLevel }
            : {}),
          ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
          ...(options?.restoredSession ? { restoreHistory: true } : {}),
        }),
      });
    })();
    pendingTabOpens.current.set(id, opening);
    opening
      .catch((err) => {
        appendSystem(`Failed to open tab: ${err}`);
      })
      .finally(() => {
        pendingTabOpens.current.delete(id);
      });
  };
}
