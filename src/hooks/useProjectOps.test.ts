// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_PROJECT_KEY, type Tab } from "../types/tab";
import type { ProjectsState } from "../projects";
import { installTauriMocks, clearTauriMocks } from "../test/tauriMocks";
import {
  nonEmptyProjectTabs,
  projectIdFromBucketKey,
  tabsForProjectBucket,
  useProjectOps,
  type UseProjectOpsContext,
} from "./useProjectOps";

afterEach(() => {
  clearTauriMocks();
});

const ref = <T>(value: T) => ({ current: value });

function makeProjectsState(
  overrides: Partial<ProjectsState> = {},
): ProjectsState {
  return {
    projects: [
      {
        id: "project-1",
        label: "aethon",
        path: "/projects/aethon",
        lastUsed: 1,
      },
    ],
    activeId: null,
    activeWorktreeId: null,
    worktreesByProject: {},
    activeHostId: null,
    ...overrides,
  };
}

function renderProjectOps(initialProjects: ProjectsState) {
  const stateRef = ref<Record<string, unknown>>({
    tabs: [],
    activeTabId: undefined,
  });
  const projectsRef = ref(initialProjects);
  const setState = vi.fn((next) => {
    stateRef.current =
      typeof next === "function" ? next(stateRef.current) : next;
  });
  const ctx: UseProjectOpsContext = {
    setState,
    stateRef,
    projectsRef,
    piDefaultModelRef: ref("gpt-5.5"),
    gitStatusRef: ref(new Map()),
    refreshGitStatusFor: vi.fn(() => Promise.resolve()),
    refreshAllGitStatus: vi.fn(() => Promise.resolve()),
    announceProjectToBridge: vi.fn(),
    watchProjectForBridge: vi.fn(),
    unwatchProjectForBridge: vi.fn(),
    dispatchTerminalReplay: vi.fn(),
    autoRestoreDiscoveredSessions: vi.fn(),
  };
  const rendered = renderHook(() => useProjectOps(ctx));
  projectsRef.current = initialProjects;
  return { ...rendered, projectsRef, stateRef, setState };
}

describe("projectIdFromBucketKey", () => {
  it("maps the no-project bucket back to null", () => {
    expect(projectIdFromBucketKey(NO_PROJECT_KEY)).toBeNull();
    expect(projectIdFromBucketKey("project-1")).toBe("project-1");
  });
});

describe("tabsForProjectBucket", () => {
  it("keeps only tabs that belong to the target project bucket", () => {
    const tabs = [
      { id: "p1", projectId: "project-1" },
      { id: "p2", projectId: "project-2" },
      { id: "none", projectId: null },
    ] as unknown as Tab[];

    expect(tabsForProjectBucket(tabs, "project-1").map((t) => t.id)).toEqual([
      "p1",
    ]);
    expect(tabsForProjectBucket(tabs, NO_PROJECT_KEY).map((t) => t.id)).toEqual(
      ["none"],
    );
  });
});

describe("nonEmptyProjectTabs", () => {
  it("drops empty agent tabs when project buckets are saved or restored", () => {
    const tabs = [
      {
        id: "blank",
        kind: "agent",
        label: "Tab 1",
        messages: [],
        draft: "",
        waiting: false,
        queueCount: 0,
        canvas: null,
        terminalBuffer: "",
      },
      {
        id: "chat",
        kind: "agent",
        label: "Chat",
        messages: [{ id: "m1", role: "user", text: "hi" }],
        draft: "",
        waiting: false,
        queueCount: 0,
        canvas: null,
        terminalBuffer: "",
      },
      { id: "shell", kind: "shell", messages: [] },
    ] as unknown as Tab[];

    expect(nonEmptyProjectTabs(tabs).map((t) => t.id)).toEqual([
      "chat",
      "shell",
    ]);
  });
});

describe("useProjectOps session scoping", () => {
  it("scopes discovered sessions to the active worktree cwd", () => {
    const { result } = renderProjectOps(
      makeProjectsState({
        activeId: "project-1",
        activeWorktreeId: "wt-1",
        worktreesByProject: {
          "project-1": [
            {
              id: "wt-1",
              projectId: "project-1",
              path: "/projects/aethon-fix-session-restore",
              branch: "fix/session-restore",
              isMain: false,
            },
          ],
        },
      }),
    );

    expect(
      result.current.scopedDiscoveredSessions([
        { tabId: "main", lastModified: 1, cwd: "/projects/aethon" },
        {
          tabId: "worktree",
          lastModified: 2,
          cwd: "/projects/aethon-fix-session-restore",
        },
      ]),
    ).toEqual([
      {
        tabId: "worktree",
        lastModified: 2,
        cwd: "/projects/aethon-fix-session-restore",
      },
    ]);
  });
});

describe("useProjectOps worktree refresh", () => {
  it("refreshes worktrees when reselecting a project with cached rows", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation((cmd: string) => {
      if (cmd === "git_worktrees") {
        return Promise.resolve([
          {
            path: "/projects/aethon",
            branch: "main",
            head: "abc123",
            isMain: true,
            locked: false,
          },
        ]);
      }
      return Promise.resolve(undefined);
    });
    const cached = {
      id: "wt-cached",
      projectId: "project-1",
      path: "/projects/aethon-old",
      branch: "old",
      isMain: false,
    };
    const { result } = renderProjectOps(
      makeProjectsState({
        worktreesByProject: { "project-1": [cached] },
      }),
    );

    act(() => {
      expect(result.current.setActiveProjectById("project-1")).toBe(true);
    });

    await waitFor(() => {
      expect(harness.invoke).toHaveBeenCalledWith("git_worktrees", {
        projectPath: "/projects/aethon",
      });
    });
  });

  it("clears a stale active worktree missing from a fresh git listing", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation((cmd: string) => {
      if (cmd === "git_worktrees") {
        return Promise.resolve([
          {
            path: "/projects/aethon",
            branch: "main",
            head: "abc123",
            isMain: true,
            locked: false,
          },
        ]);
      }
      return Promise.resolve(undefined);
    });
    const staleWorktree = {
      id: "wt-deleted",
      projectId: "project-1",
      path: "/projects/aethon-deleted",
      branch: "deleted",
      isMain: false,
    };
    const { result, projectsRef } = renderProjectOps(
      makeProjectsState({
        activeId: "project-1",
        activeWorktreeId: "wt-deleted",
        worktreesByProject: { "project-1": [staleWorktree] },
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    projectsRef.current = makeProjectsState({
      activeId: "project-1",
      activeWorktreeId: "wt-deleted",
      worktreesByProject: { "project-1": [staleWorktree] },
    });

    await act(async () => {
      await result.current.refreshProjectWorktrees("project-1");
    });

    expect(projectsRef.current.activeWorktreeId).toBeNull();
    expect(projectsRef.current.worktreesByProject["project-1"]).toHaveLength(1);
    expect(
      projectsRef.current.worktreesByProject["project-1"]?.[0],
    ).toMatchObject({
      path: "/projects/aethon",
      branch: "main",
      isMain: true,
    });
  });
});

describe("useProjectOps worktree creation", () => {
  it("creates worktrees from origin/main by default and activates the result", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation((cmd: string) => {
      if (cmd === "git_worktree_add") {
        return Promise.resolve({
          path: "/projects/aethon-fix-thing",
          branch: "fix/thing",
          head: "def456",
          isMain: false,
          locked: false,
        });
      }
      if (cmd === "git_worktrees") {
        return Promise.resolve([
          {
            path: "/projects/aethon",
            branch: "main",
            head: "abc123",
            isMain: true,
            locked: false,
          },
          {
            path: "/projects/aethon-fix-thing",
            branch: "fix/thing",
            head: "def456",
            isMain: false,
            locked: false,
          },
        ]);
      }
      return Promise.resolve(undefined);
    });
    const initial = makeProjectsState({ activeId: "project-1" });
    const { result, projectsRef } = renderProjectOps(initial);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    projectsRef.current = initial;

    await act(async () => {
      const created = await result.current.createWorktreeWithParams({
        projectId: "project-1",
        branch: "fix/thing",
      });
      expect(created).toBe("/projects/aethon-fix-thing");
    });

    expect(harness.invoke).toHaveBeenCalledWith("git_worktree_add", {
      projectPath: "/projects/aethon",
      targetPath: "/projects/aethon-fix-thing",
      branch: "fix/thing",
      base: "origin/main",
    });
    expect(projectsRef.current.activeWorktreeId).toBeTruthy();
    const active = projectsRef.current.worktreesByProject["project-1"]?.find(
      (w) => w.id === projectsRef.current.activeWorktreeId,
    );
    expect(active?.path).toBe("/projects/aethon-fix-thing");
    expect(projectsRef.current.projects[0].uiExpanded).toBe(true);
  });

  it("uses project and explicit base branch overrides in priority order", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation((cmd: string) => {
      if (cmd === "git_worktree_add") {
        return Promise.resolve({
          path: "/projects/aethon-topic",
          branch: "topic",
          head: "def456",
          isMain: false,
          locked: false,
        });
      }
      if (cmd === "git_worktrees") {
        return Promise.resolve([
          {
            path: "/projects/aethon-topic",
            branch: "topic",
            head: "def456",
            isMain: false,
            locked: false,
          },
        ]);
      }
      return Promise.resolve(undefined);
    });
    const initial = makeProjectsState({
      activeId: "project-1",
      projects: [
        {
          id: "project-1",
          label: "aethon",
          path: "/projects/aethon",
          lastUsed: 1,
          worktreeBaseBranch: "upstream/trunk",
        },
      ],
    });
    const { result, projectsRef } = renderProjectOps(initial);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    projectsRef.current = initial;

    await act(async () => {
      await result.current.createWorktreeWithParams({
        projectId: "project-1",
        branch: "topic",
      });
      await result.current.createWorktreeWithParams({
        projectId: "project-1",
        branch: "topic-2",
        baseBranch: "release/next",
      });
    });

    const addCalls = harness.invoke.mock.calls.filter(
      ([cmd]) => cmd === "git_worktree_add",
    );
    expect(addCalls[0]?.[1]).toMatchObject({ base: "upstream/trunk" });
    expect(addCalls[1]?.[1]).toMatchObject({ base: "release/next" });
  });
});
