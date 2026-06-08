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
        activeWorktreeId: null,
        activeHostId: null,
        projects: [],
        worktreesByProject: {},
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

  it("prepares the devshell before opening a cwd-backed agent tab", async () => {
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
        activeWorktreeId: null,
        activeHostId: null,
        projects: [
          {
            id: "p1",
            label: "Project",
            path: "/proj",
            lastUsed: 1,
          },
        ],
        worktreesByProject: {},
      }),
      piDefaultModelRef: ref(""),
      pendingTabOpens: pending,
      appendSystem: vi.fn(),
      dispatchTerminalReplay: vi.fn(),
    });

    newTab("tab-1", "Project");
    await pending.current.get("tab-1");

    expect(invokeMock.mock.calls[0]).toEqual([
      "devshell_prepare_for_path",
      { args: { cwd: "/proj", includeEnv: false } },
    ]);
    expect(invokeMock.mock.calls[1]?.[0]).toBe("agent_command");
  });
});
