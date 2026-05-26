import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { makeEmptyTab, type Tab } from "../../types/tab";
import type { ProjectsState } from "../../projects";
import { recomputeModelPicker } from "../../utils/modelPicker";
import { TAB_MIRROR_KEYS } from "./constants";
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
  } = deps;

  return function newTab(
    restoreId?: string,
    restoreLabel?: string,
    options?: {
      restoredSession?: boolean;
      cwd?: string;
      scrollToMatch?: string;
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
    );
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
        ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
      };
      tabs.push(tab);
      const result: Record<string, unknown> = {
        ...prev,
        tabs,
        activeTabId: id,
        empty: false,
        hasTabs: true,
      };
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
    dispatchTerminalReplay("");
    const opening = invoke("agent_command", {
      payload: JSON.stringify({
        type: "tab_open",
        tabId: id,
        ...(inheritedModel ? { model: inheritedModel } : {}),
        ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
        ...(options?.restoredSession ? { restoreHistory: true } : {}),
      }),
    });
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
