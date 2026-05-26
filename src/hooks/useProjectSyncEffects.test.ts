// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectsState } from "../projects";
import { makeEmptyTab } from "../types/tab";
import { useProjectSyncEffects } from "./useProjectSyncEffects";

const discoverIconMock = vi.hoisted(() => vi.fn());

vi.mock("../projectIcons", () => ({
  discoverIcon: discoverIconMock,
}));

const ref = <T>(value: T) => ({ current: value });

function makeProjects(): ProjectsState {
  return {
    projects: [
      {
        id: "project-1",
        label: "Aethon",
        path: "/repo/aethon",
        lastUsed: 1,
      },
    ],
    activeId: null,
    activeWorktreeId: null,
    worktreesByProject: {
      "project-1": [
        {
          id: "wt-main",
          projectId: "project-1",
          path: "/repo/aethon",
          branch: "main",
          isMain: true,
        },
        {
          id: "wt-task",
          projectId: "project-1",
          path: "/repo/aethon-task",
          branch: "feat/task",
          isMain: false,
        },
      ],
    },
    activeHostId: null,
  };
}

describe("useProjectSyncEffects", () => {
  it("syncs the active project and worktree from the active agent tab", async () => {
    const projectsRef = ref(makeProjects());
    const stateRef = ref<Record<string, unknown>>({
      activeTabId: "tab-1",
      tabs: [
        {
          ...makeEmptyTab("tab-1", "Task", "project-1"),
          projectId: "project-1",
          cwd: "/repo/aethon-task",
        },
      ],
    });
    const setActiveProjectById = vi.fn((id: string) => {
      projectsRef.current.activeId = id;
      return true;
    });
    const activateWorktree = vi.fn((id: string | null) => {
      projectsRef.current.activeWorktreeId = id;
    });

    renderHook(() =>
      useProjectSyncEffects({
        state: stateRef.current,
        stateRef,
        projectsRef,
        setActiveProjectById,
        activateWorktree,
        setProjectIconUrl: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(setActiveProjectById).toHaveBeenCalledWith("project-1");
      expect(activateWorktree).toHaveBeenCalledWith("wt-task");
    });
  });

  it("discovers missing project icons", async () => {
    discoverIconMock.mockResolvedValueOnce("file:///repo/aethon/icon.png");
    const projectsRef = ref(makeProjects());
    const setProjectIconUrl = vi.fn();

    renderHook(() =>
      useProjectSyncEffects({
        state: { projects: projectsRef.current.projects },
        stateRef: ref({}),
        projectsRef,
        setActiveProjectById: vi.fn(),
        activateWorktree: vi.fn(),
        setProjectIconUrl,
      }),
    );

    await waitFor(() => {
      expect(setProjectIconUrl).toHaveBeenCalledWith(
        "project-1",
        "file:///repo/aethon/icon.png",
      );
    });
  });

  it("ignores icon results for stale projects", async () => {
    let resolveIcon: (value: string | null) => void = () => {};
    discoverIconMock.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveIcon = resolve;
        }),
    );
    const projectsRef = ref(makeProjects());
    const setProjectIconUrl = vi.fn();

    renderHook(() =>
      useProjectSyncEffects({
        state: { projects: projectsRef.current.projects },
        stateRef: ref({}),
        projectsRef,
        setActiveProjectById: vi.fn(),
        activateWorktree: vi.fn(),
        setProjectIconUrl,
      }),
    );

    await waitFor(() => {
      expect(discoverIconMock).toHaveBeenCalled();
    });

    projectsRef.current.projects = [];
    await act(async () => {
      resolveIcon("file:///repo/aethon/icon.png");
      await Promise.resolve();
    });

    expect(setProjectIconUrl).not.toHaveBeenCalled();
  });
});
