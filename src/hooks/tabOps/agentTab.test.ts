import { describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { useNewTab } from "./agentTab";
import type { ProjectsState } from "../../projects";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

const ref = <T>(value: T): MutableRefObject<T> => ({ current: value });

describe("newTab restore handling", () => {
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
});
