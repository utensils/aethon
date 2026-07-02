import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNewTab } from "./agentTab";
import type { ProjectsState } from "../../projects";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

const ref = <T>(value: T): MutableRefObject<T> => ({ current: value });

describe("newTab restore handling", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("clears the closed-session suppression when a session is manually restored", () => {
    let state: Record<string, unknown> = {
      tabs: [],
      closedSessionIds: ["restore-me", "other-closed"],
    };
    const stateRef = ref(state);
    const setState = vi.fn((updater: unknown) => {
      if (typeof updater !== "function") return;
      state = (
        updater as (prev: Record<string, unknown>) => Record<string, unknown>
      )(state);
      stateRef.current = state;
    });
    const newTab = useNewTab({
      setState,
      stateRef,
      projectsRef: ref<ProjectsState>({
        activeId: null,
        activeWorkspaceId: null,
        activeHostId: null,
        projects: [],
        workspacesByProject: {},
      }),
      piDefaultModelRef: ref(""),
      pendingTabOpens: ref(new Map()),
      appendSystem: vi.fn(),
      dispatchTerminalReplay: vi.fn(),
    });

    newTab("restore-me", "Restored", { restoredSession: true });

    expect(state.closedSessionIds).toEqual(["other-closed"]);
    expect((state.tabs as Array<{ id: string }>).map((t) => t.id)).toEqual([
      "restore-me",
    ]);
  });

  it("passes the selected default reasoning level to new bridge tabs", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValue(null);
    let state: Record<string, unknown> = {
      tabs: [],
      defaultThinkingLevel: "high",
    };
    const stateRef = ref(state);
    const setState = vi.fn((updater: unknown) => {
      if (typeof updater !== "function") return;
      state = (
        updater as (prev: Record<string, unknown>) => Record<string, unknown>
      )(state);
      stateRef.current = state;
    });
    const pending = ref(new Map<string, Promise<unknown>>());
    const newTab = useNewTab({
      setState,
      stateRef,
      projectsRef: ref<ProjectsState>({
        activeId: null,
        activeWorkspaceId: null,
        activeHostId: null,
        projects: [],
        workspacesByProject: {},
      }),
      piDefaultModelRef: ref("openai-codex/gpt-5.5"),
      pendingTabOpens: pending,
      appendSystem: vi.fn(),
      dispatchTerminalReplay: vi.fn(),
    });

    newTab("tab-1", "Project");
    await pending.current.get("tab-1");

    expect(
      (state.tabs as Array<{ thinkingLevel?: string }>)[0].thinkingLevel,
    ).toBe("high");
    expect(invokeMock).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "tab_open",
        tabId: "tab-1",
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "high",
      }),
    });
  });

  it("does not inherit a local cwd for host-level remote tabs", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValue(null);
    let state: Record<string, unknown> = {
      tabs: [],
      activeHostId: "remote:fp",
      aethonRoot: "/Users/local/.aethon",
      projectRoot: "/Users/local/src/aethon",
    };
    const stateRef = ref(state);
    const setState = vi.fn((updater: unknown) => {
      if (typeof updater !== "function") return;
      state = (
        updater as (prev: Record<string, unknown>) => Record<string, unknown>
      )(state);
      stateRef.current = state;
    });
    const pending = ref(new Map<string, Promise<unknown>>());
    const newTab = useNewTab({
      setState,
      stateRef,
      projectsRef: ref<ProjectsState>({
        activeId: null,
        activeWorkspaceId: null,
        activeHostId: "remote:fp",
        projects: [],
        workspacesByProject: {},
      }),
      piDefaultModelRef: ref("openai-codex/gpt-5.5"),
      pendingTabOpens: pending,
      appendSystem: vi.fn(),
      dispatchTerminalReplay: vi.fn(),
    });

    newTab("tab-remote", "Remote");
    await pending.current.get("tab-remote");

    expect(invokeMock).toHaveBeenCalledWith("remote_host_invoke", {
      id: "remote:fp",
      cmd: "agent_command",
      args: {
        payload: JSON.stringify({
          type: "tab_open",
          tabId: "tab-remote",
          model: "openai-codex/gpt-5.5",
        }),
      },
    });
    expect((state.tabs as Array<{ cwd?: string; hostId?: string }>)[0]).toMatchObject({
      hostId: "remote:fp",
    });
    expect((state.tabs as Array<{ cwd?: string }>)[0].cwd).toBeUndefined();
  });

  it("prepares workspace startup before opening a cwd-backed agent tab", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValue(null);
    let state: Record<string, unknown> = { tabs: [] };
    const stateRef = ref(state);
    const setState = vi.fn((updater: unknown) => {
      if (typeof updater !== "function") return;
      state = (
        updater as (prev: Record<string, unknown>) => Record<string, unknown>
      )(state);
      stateRef.current = state;
    });
    const pending = ref(new Map<string, Promise<unknown>>());
    const newTab = useNewTab({
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
      piDefaultModelRef: ref(""),
      pendingTabOpens: pending,
      appendSystem: vi.fn(),
      dispatchTerminalReplay: vi.fn(),
    });

    newTab("tab-1", "Project");
    await pending.current.get("tab-1");

    expect(invokeMock.mock.calls[0]).toEqual([
      "workspace_startup_prepare_for_path",
      { args: { cwd: "/proj" } },
    ]);
    expect(invokeMock.mock.calls[1]?.[0]).toBe("agent_command");
  });

  it("does not open the agent tab when required workspace startup rejects", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation((command) =>
      command === "workspace_startup_prepare_for_path"
        ? Promise.reject(new Error("startup approval required"))
        : Promise.resolve(null),
    );
    let state: Record<string, unknown> = { tabs: [] };
    const stateRef = ref(state);
    const setState = vi.fn((updater: unknown) => {
      if (typeof updater !== "function") return;
      state = (
        updater as (prev: Record<string, unknown>) => Record<string, unknown>
      )(state);
      stateRef.current = state;
    });
    const appendSystem = vi.fn();
    const pending = ref(new Map<string, Promise<unknown>>());
    const newTab = useNewTab({
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
      piDefaultModelRef: ref(""),
      pendingTabOpens: pending,
      appendSystem,
      dispatchTerminalReplay: vi.fn(),
    });

    newTab("tab-1", "Project");
    await pending.current.get("tab-1");

    expect(invokeMock.mock.calls[0]?.[0]).toBe("workspace_startup_prepare_for_path");
    expect(invokeMock.mock.calls.some((call) => call[0] === "agent_command")).toBe(false);
    expect(appendSystem).toHaveBeenCalledWith(
      "Workspace startup blocked for /proj: startup approval required",
    );
    expect((state.tabs as Array<{ waiting: boolean }>)[0].waiting).toBe(false);
  });

  it("shows retained devshell output immediately when opening a cwd-backed agent tab", () => {
    let state: Record<string, unknown> = {
      tabs: [],
      devshell: {
        outputByRoot: {
          "/proj": "building deps\r\n",
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
    const dispatchTerminalReplay = vi.fn();
    const newTab = useNewTab({
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
      piDefaultModelRef: ref(""),
      pendingTabOpens: ref(new Map()),
      appendSystem: vi.fn(),
      dispatchTerminalReplay,
    });

    newTab("tab-1", "Project");

    const tab = (
      state.tabs as Array<{ terminalBuffer: string; waiting: boolean }>
    )[0];
    expect(tab.terminalBuffer).toBe("building deps\r\n");
    expect(tab.waiting).toBe(true);
    expect(dispatchTerminalReplay).toHaveBeenCalledWith("building deps\r\n");
  });
});
