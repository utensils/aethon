import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNewShellTab } from "./shellTab";
import type { ProjectsState } from "../../projects";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

const ref = <T>(value: T): MutableRefObject<T> => ({ current: value });

describe("newShellTab", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("opens a project shell tab with retained devshell output visible immediately", () => {
    let state: Record<string, unknown> = {
      tabs: [],
      devshell: {
        outputByRoot: {
          "/proj": "[devshell] Preparing Nix devshell for this workspace...\r\n",
        },
        entries: {
          "/proj": { state: "resolving" },
        },
      },
    };
    const stateRef = ref(state);
    const setState = vi.fn((updater: unknown) => {
      if (typeof updater !== "function") return;
      state = (
        updater as (prev: Record<string, unknown>) => Record<string, unknown>
      )(state);
      stateRef.current = state;
    });

    const newShellTab = useNewShellTab({
      setState,
      stateRef,
      projectsRef: ref<ProjectsState>({
        activeId: "p1",
        activeWorkspaceId: null,
        activeHostId: null,
        projects: [
          {
            id: "p1",
            label: "Project",
            path: "/proj",
            lastUsed: 1,
          },
        ],
        workspacesByProject: {},
      }),
      appendSystem: vi.fn(),
      defaultShareModeRef: ref("read"),
      shellDefaultCommandRef: ref(null),
      shellDefaultArgsRef: ref([]),
      shellInheritEnvRef: ref(true),
      updateTab: vi.fn(),
    });

    newShellTab();

    const tab = (
      state.tabs as Array<{
        id: string;
        terminalBuffer: string;
        shell: { cwd: string; shellState: string };
      }>
    )[0];
    expect(tab.terminalBuffer).toBe(
      "[devshell] Preparing Nix devshell for this workspace...\r\n",
    );
    expect(tab.shell).toMatchObject({ cwd: "/proj", shellState: "starting" });
    expect(state.terminalPanel).toMatchObject({ activeSubId: tab.id });
    expect(invoke).toHaveBeenCalledWith("shell_open", {
      args: {
        tabId: tab.id,
        cwd: "/proj",
        shareMode: "read",
      },
    });
  });
});
