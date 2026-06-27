import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { makeEmptyTab, type ShellMeta, type Tab } from "../../types/tab";
import type { ProjectsState } from "../../projects";
import { initialDevshellTerminalBuffer } from "./devshellTerminal";
import { cwdForNewTab } from "./helpers";

export interface NewShellTabDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  appendSystem: (text: string) => void;
  /** Live config refs — populated by the boot config effect and the
   *  settings-panel apply path; read via `.current` at open time. */
  defaultShareModeRef: MutableRefObject<ShellMeta["shareMode"]>;
  shellDefaultCommandRef: MutableRefObject<string | null>;
  shellDefaultArgsRef: MutableRefObject<string[]>;
  shellInheritEnvRef: MutableRefObject<boolean>;
  /** Project/workspace startup gate. Resolves once env providers and
   *  approved bootstrapping commands have completed for the cwd. */
  prepareWorkspaceStartup?: (cwd: string) => Promise<boolean>;
  /** Callback into mutations.updateTab — patches the tab's shellState
   *  on bridge success/failure without re-implementing the mirror dance. */
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
}

/** Build the shell-tab creator. Shell tabs live in the bottom panel as
 *  sub-tabs, NOT the top tab strip, so opening one promotes it to the
 *  panel's `activeSubId` and forces the panel open — but never touches
 *  `/activeTabId`. The Rust side seeds the configured share mode
 *  atomically inside `shell_open` so a non-private default pins the
 *  privacy floor at total_appended=0 (the user sees the login banner). */
export function useNewShellTab(deps: NewShellTabDeps) {
  const {
    setState,
    stateRef,
    projectsRef,
    appendSystem,
    defaultShareModeRef,
    shellDefaultCommandRef,
    shellDefaultArgsRef,
    shellInheritEnvRef,
    prepareWorkspaceStartup,
    updateTab,
  } = deps;

  return function newShellTab(options?: {
    command?: string;
    args?: string[];
    cwd?: string;
  }): void {
    const id = crypto.randomUUID();
    const inheritedCwd =
      options?.cwd ??
      cwdForNewTab(projectsRef.current, stateRef.current) ??
      undefined;
    const seedShareMode = defaultShareModeRef.current;
    const resolvedCommand =
      options?.command ?? shellDefaultCommandRef.current ?? undefined;
    const resolvedArgs =
      options?.args ??
      (shellDefaultArgsRef.current.length > 0
        ? shellDefaultArgsRef.current
        : undefined);
    const inheritEnv = shellInheritEnvRef.current;
    const initialTerminalBuffer = inheritedCwd
      ? initialDevshellTerminalBuffer(stateRef.current, inheritedCwd)
      : "";
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const label = `Shell ${tabs.filter((t) => t.kind === "shell").length + 1}`;
      const projectId = projectsRef.current.activeId;
      const tab: Tab = {
        ...makeEmptyTab(id, label, projectId, "shell"),
        terminalBuffer: initialTerminalBuffer,
        shell: {
          cwd: inheritedCwd ?? "",
          command: resolvedCommand ?? "",
          args: resolvedArgs ?? [],
          shareMode: seedShareMode,
          shellState: "starting",
        },
      };
      tabs.push(tab);
      // M6 restructure: shells live in the bottom panel as sub-tabs,
      // not the top tab strip. Don't promote to /activeTabId — that
      // stays on the user's agent tab. Instead, open the panel and
      // make this shell the active sub-tab so the user sees it.
      const panel =
        (prev.terminalPanel as { activeSubId?: string } | undefined) ?? {};
      const term = (prev.terminal as { open?: boolean } | undefined) ?? {};
      return {
        ...prev,
        tabs,
        terminalPanel: { ...panel, activeSubId: id },
        terminal: { ...term, open: true },
      };
    });
    const openShell = async (): Promise<boolean> => {
      if (inheritedCwd) {
        const ready = prepareWorkspaceStartup
          ? await prepareWorkspaceStartup(inheritedCwd)
          : await invoke<{ state?: string }>(
              "workspace_startup_prepare_for_path",
              {
                args: { cwd: inheritedCwd },
              },
            ).then((status) =>
              ["ready", "continued", "disabled"].includes(
                status?.state ?? "ready",
              ),
            );
        if (!ready) throw new Error("workspace startup not ready");
      }
      if (!shellTabStillExists(stateRef.current, id)) return false;
      await invoke("shell_open", {
        args: {
          tabId: id,
          ...(resolvedCommand ? { command: resolvedCommand } : {}),
          ...(resolvedArgs ? { args: resolvedArgs } : {}),
          ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
          // Seed the share mode atomically inside shell_open so the
          // privacy floor pins at total_appended=0 — every byte from the
          // first prompt forward is visible to the agent when the user
          // configured a non-private default. Applying the mode post-open
          // would race the login banner and pin it below the floor.
          ...(seedShareMode !== "private" ? { shareMode: seedShareMode } : {}),
          ...(inheritEnv === false ? { inheritEnv: false } : {}),
        },
      });
      return true;
    };
    openShell()
      .then((opened) => {
        if (!opened) return;
        updateTab(id, (t) => ({
          ...t,
          shell: t.shell ? { ...t.shell, shellState: "running" } : t.shell,
        }));
      })
      .catch((err: unknown) => {
        if (!shellTabStillExists(stateRef.current, id)) return;
        appendSystem(`Failed to open shell tab: ${String(err)}`);
        updateTab(id, (t) => ({
          ...t,
          shell: t.shell
            ? { ...t.shell, shellState: "exited", exitCode: -1 }
            : t.shell,
        }));
      });
  };
}

function shellTabStillExists(
  state: Record<string, unknown>,
  id: string,
): boolean {
  const tabs = (state.tabs as Tab[] | undefined) ?? [];
  return tabs.some((tab) => tab.id === id && tab.kind === "shell");
}
