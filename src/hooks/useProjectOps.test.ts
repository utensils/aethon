// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeEmptyTab,
  NO_PROJECT_KEY,
  OVERVIEW_TAB_ID,
  type Tab,
} from "../types/tab";
import type { ProjectsState } from "../projects";
import { installTauriMocks, clearTauriMocks } from "../test/tauriMocks";
import {
  nonEmptyProjectTabs,
  projectIdFromBucketKey,
  projectScopeBucketKey,
  tabsForProjectBucket,
  useProjectOps,
  workspaceIdForCwd,
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
    activeWorkspaceId: null,
    workspacesByProject: {},
    activeHostId: null,
    ...overrides,
  };
}

function nonEmptyAgentTab(
  id: string,
  label: string,
  projectId: string | null,
  cwd?: string,
): Tab {
  return {
    ...makeEmptyTab(id, label, projectId),
    ...(cwd ? { cwd } : {}),
    messages: [{ id: `${id}-msg`, role: "user", text: label }],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderProjectOps(
  initialProjects: ProjectsState,
  overrides: Partial<UseProjectOpsContext> = {},
) {
  const stateRef = ref<Record<string, unknown>>({
    tabs: [],
    activeTabId: undefined,
  });
  const projectsRef = ref(initialProjects);
  const setState = vi.fn((next) => {
    stateRef.current =
      typeof next === "function" ? next(stateRef.current) : next;
  });
  const closeTabNow = vi.fn((tabId: string) => {
    setState((prev: Record<string, unknown>) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).filter(
        (tab) => tab.id !== tabId,
      );
      const activeTabId =
        prev.activeTabId === tabId
          ? tabs[tabs.length - 1]?.id
          : (prev.activeTabId as string | undefined);
      return { ...prev, tabs, activeTabId };
    });
  });
  const workspacePrompts = {
    promptRemoveWorkspace: vi.fn(() => Promise.resolve(true)),
    promptForceRemove: vi.fn(() => Promise.resolve(true)),
    promptOrphanCleanup: vi.fn(() => Promise.resolve(true)),
    notifyCannotRemoveMain: vi.fn(),
    notifyFailure: vi.fn(),
  };
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
    closeTabNow,
    workspacePrompts,
    ...overrides,
  };
  const rendered = renderHook(() => useProjectOps(ctx));
  projectsRef.current = initialProjects;
  return {
    ...rendered,
    projectsRef,
    stateRef,
    setState,
    closeTabNow,
    workspacePrompts: ctx.workspacePrompts,
  };
}

describe("projectIdFromBucketKey", () => {
  it("maps the no-project bucket back to null", () => {
    expect(projectIdFromBucketKey(NO_PROJECT_KEY)).toBeNull();
    expect(projectIdFromBucketKey("project-1")).toBe("project-1");
    expect(projectIdFromBucketKey("project-1::workspace::wt-1")).toBe(
      "project-1",
    );
  });
});

describe("tabsForProjectBucket", () => {
  it("keeps only tabs that belong to the target project bucket", () => {
    const tabs = [
      { id: "p1", projectId: "project-1" },
      { id: "p2", projectId: "project-2" },
      { id: "none", projectId: null },
    ] as unknown as Tab[];

    expect(
      tabsForProjectBucket(
        tabs,
        projectScopeBucketKey("project-1", "wt-1"),
      ).map((t) => t.id),
    ).toEqual(["p1"]);
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
  it("resolves a session cwd to the matching workspace selection", () => {
    const projects = makeProjectsState({
      activeId: "project-1",
      activeWorkspaceId: null,
      workspacesByProject: {
        "project-1": [
          {
            id: "wt-main",
            projectId: "project-1",
            path: "/projects/aethon",
            branch: "main",
            isMain: true,
          },
          {
            id: "wt-issue",
            projectId: "project-1",
            path: "/projects/aethon-fix-issue",
            branch: "fix/issue",
            isMain: false,
          },
        ],
      },
    });

    expect(workspaceIdForCwd(projects, "/projects/aethon-fix-issue/")).toBe(
      "wt-issue",
    );
    expect(workspaceIdForCwd(projects, "/projects/aethon-fix-issue/app")).toBe(
      "wt-issue",
    );
    expect(workspaceIdForCwd(projects, "/projects/aethon")).toBeNull();
    expect(
      workspaceIdForCwd(projects, "/projects/aethon-fix-issue-sibling"),
    ).toBeUndefined();
    expect(workspaceIdForCwd(projects, "/projects/other")).toBeUndefined();
  });

  it("marks the child workspace as selected without painting the parent row active", () => {
    const { result, stateRef } = renderProjectOps(
      makeProjectsState({
        activeId: "project-1",
        activeWorkspaceId: null,
        projects: [
          {
            id: "project-1",
            label: "aethon",
            path: "/projects/aethon",
            lastUsed: 1,
          },
        ],
        workspacesByProject: {
          "project-1": [
            {
              id: "wt-main",
              projectId: "project-1",
              path: "/projects/aethon",
              branch: "main",
              isMain: true,
            },
            {
              id: "wt-issue",
              projectId: "project-1",
              path: "/projects/aethon-fix-issue",
              branch: "fix/issue",
              isMain: false,
            },
          ],
        },
      }),
    );

    act(() => {
      result.current.activateWorkspace("wt-issue");
    });

    const projects = (
      stateRef.current.sidebar as {
        projects?: {
          active?: boolean;
          workspaces?: { id: string; active?: boolean }[];
        }[];
      }
    ).projects;
    expect(projects?.[0]?.active).toBe(false);
    expect(
      projects?.[0]?.workspaces?.find((w) => w.id === "wt-issue")?.active,
    ).toBe(true);
    expect(stateRef.current.activeProjectId).toBe("project-1");
  });

  it("keeps project-root and workspace tabs in separate visible buckets", () => {
    const rootTab = {
      id: "root-tab",
      kind: "agent",
      projectId: "project-1",
      cwd: "/projects/aethon",
      messages: [{ id: "m-root", role: "user", text: "root" }],
      terminalBuffer: "",
      model: "gpt-5.5",
    } as unknown as Tab;
    const workspaceTab = {
      id: "workspace-tab",
      kind: "agent",
      projectId: "project-1",
      cwd: "/projects/aethon-fix-issue",
      messages: [{ id: "m-wt", role: "user", text: "workspace" }],
      terminalBuffer: "",
      model: "gpt-5.5",
    } as unknown as Tab;
    const { result, stateRef, projectsRef } = renderProjectOps(
      makeProjectsState({
        activeId: "project-1",
        activeWorkspaceId: null,
        workspacesByProject: {
          "project-1": [
            {
              id: "wt-issue",
              projectId: "project-1",
              path: "/projects/aethon-fix-issue",
              branch: "fix/issue",
              isMain: false,
            },
          ],
        },
      }),
    );
    stateRef.current = {
      ...stateRef.current,
      tabs: [rootTab],
      activeTabId: "root-tab",
    };

    act(() => {
      result.current.activateWorkspace("wt-issue");
    });

    expect(projectsRef.current.activeWorkspaceId).toBe("wt-issue");
    expect((stateRef.current.tabs as Tab[]).map((t) => t.id)).toEqual([]);

    stateRef.current = {
      ...stateRef.current,
      tabs: [workspaceTab],
      activeTabId: "workspace-tab",
    };

    act(() => {
      expect(result.current.setActiveProjectById("project-1")).toBe(true);
    });

    expect(projectsRef.current.activeWorkspaceId).toBeNull();
    expect((stateRef.current.tabs as Tab[]).map((t) => t.id)).toEqual([
      "root-tab",
    ]);
    expect(stateRef.current.activeTabId).toBe("root-tab");
  });

  it("clears stale landing when activateWorkspace restores a saved tab", () => {
    const workspaceTab = {
      ...nonEmptyAgentTab("workspace-tab", "Workspace chat", "project-1"),
      cwd: "/projects/aethon-fix-issue",
    };
    const { result, stateRef, projectsRef } = renderProjectOps(
      makeProjectsState({
        activeId: "project-1",
        activeWorkspaceId: "wt-issue",
        workspacesByProject: {
          "project-1": [
            {
              id: "wt-issue",
              projectId: "project-1",
              path: "/projects/aethon-fix-issue",
              branch: "fix/issue",
              isMain: false,
            },
            {
              id: "wt-empty",
              projectId: "project-1",
              path: "/projects/aethon-empty",
              branch: "empty",
              isMain: false,
            },
          ],
        },
      }),
    );
    stateRef.current = {
      ...stateRef.current,
      tabs: [workspaceTab],
      activeTabId: "workspace-tab",
    };

    act(() => {
      result.current.activateWorkspace("wt-empty");
    });
    expect((stateRef.current.tabs as Tab[]).map((t) => t.id)).toEqual([]);

    stateRef.current = {
      ...stateRef.current,
      landing: { kind: "workspace", workspaceId: "wt-empty" },
      messages: [{ id: "stale", role: "user", text: "stale" }],
      draft: "stale draft",
    };

    act(() => {
      result.current.activateWorkspace("wt-issue");
    });

    expect(projectsRef.current.activeWorkspaceId).toBe("wt-issue");
    expect((stateRef.current.tabs as Tab[]).map((t) => t.id)).toEqual([
      "workspace-tab",
    ]);
    expect(stateRef.current.activeTabId).toBe("workspace-tab");
    expect(stateRef.current.landing).toBeNull();
    expect(stateRef.current.messages).toEqual(workspaceTab.messages);
    expect(stateRef.current.draft).toBe(workspaceTab.draft);
  });

  it("swaps the project extensions watcher when a workspace from another project is activated", () => {
    // Regression: activateWorkspace changed activeId directly when the
    // workspace belonged to a different project than the current one,
    // skipping the unwatch/watch swap that setActiveProjectById does.
    // The previous project's `.aethon/extensions/` watcher kept
    // firing while the new project's never got installed.
    const initial = makeProjectsState({
      activeId: "project-1",
      activeWorkspaceId: null,
      projects: [
        {
          id: "project-1",
          label: "alpha",
          path: "/projects/alpha",
          lastUsed: 1,
        },
        {
          id: "project-2",
          label: "beta",
          path: "/projects/beta",
          lastUsed: 1,
        },
      ],
      workspacesByProject: {
        "project-2": [
          {
            id: "wt-beta-feature",
            projectId: "project-2",
            path: "/projects/beta-feature",
            branch: "feat/x",
            isMain: false,
          },
        ],
      },
    });
    const stateRef = ref<Record<string, unknown>>({
      tabs: [],
      activeTabId: undefined,
    });
    const projectsRef = ref(initial);
    const setState = vi.fn((next: unknown) => {
      stateRef.current =
        typeof next === "function"
          ? (next as (s: Record<string, unknown>) => Record<string, unknown>)(
              stateRef.current,
            )
          : (next as Record<string, unknown>);
    });
    const watchProjectForBridge = vi.fn();
    const unwatchProjectForBridge = vi.fn();
    const ctx: UseProjectOpsContext = {
      setState,
      stateRef,
      projectsRef,
      piDefaultModelRef: ref("gpt-5.5"),
      gitStatusRef: ref(new Map()),
      refreshGitStatusFor: vi.fn(() => Promise.resolve()),
      refreshAllGitStatus: vi.fn(() => Promise.resolve()),
      announceProjectToBridge: vi.fn(),
      watchProjectForBridge,
      unwatchProjectForBridge,
      dispatchTerminalReplay: vi.fn(),
      autoRestoreDiscoveredSessions: vi.fn(),
      closeTabNow: vi.fn(),
      workspacePrompts: {
        promptRemoveWorkspace: vi.fn(() => Promise.resolve(true)),
        promptForceRemove: vi.fn(() => Promise.resolve(true)),
        promptOrphanCleanup: vi.fn(() => Promise.resolve(true)),
        notifyCannotRemoveMain: vi.fn(),
        notifyFailure: vi.fn(),
      },
    };
    const { result } = renderHook(() => useProjectOps(ctx));
    projectsRef.current = initial;

    act(() => {
      result.current.activateWorkspace("wt-beta-feature");
    });

    // Previous project's watcher uninstalled, new project's watcher
    // installed in lockstep.
    expect(unwatchProjectForBridge).toHaveBeenCalledWith("/projects/alpha");
    expect(watchProjectForBridge).toHaveBeenCalledWith("/projects/beta");
    expect(projectsRef.current.activeId).toBe("project-2");
    expect(projectsRef.current.activeWorkspaceId).toBe("wt-beta-feature");
  });

  it("scopes discovered sessions to the active workspace cwd", () => {
    const { result } = renderProjectOps(
      makeProjectsState({
        activeId: "project-1",
        activeWorkspaceId: "wt-1",
        workspacesByProject: {
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
          tabId: "workspace",
          lastModified: 2,
          cwd: "/projects/aethon-fix-session-restore",
        },
      ]),
    ).toEqual([
      {
        tabId: "workspace",
        lastModified: 2,
        cwd: "/projects/aethon-fix-session-restore",
      },
    ]);
  });

  it("excludes project and workspace sessions from the host scope", () => {
    const { result } = renderProjectOps(
      makeProjectsState({
        activeId: null,
        activeWorkspaceId: null,
        projects: [
          {
            id: "project-1",
            label: "aethon",
            path: "/projects/aethon",
            lastUsed: 1,
          },
        ],
        workspacesByProject: {
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
        { tabId: "host", lastModified: 1 },
        { tabId: "project", lastModified: 2, cwd: "/projects/aethon/" },
        {
          tabId: "workspace",
          lastModified: 3,
          cwd: "/projects/aethon-fix-session-restore",
        },
        { tabId: "other-host-cwd", lastModified: 4, cwd: "/tmp/scratch" },
      ]),
    ).toEqual([
      { tabId: "host", lastModified: 1 },
      { tabId: "other-host-cwd", lastModified: 4, cwd: "/tmp/scratch" },
    ]);
  });
});

describe("useProjectOps overview terminal project switches", () => {
  function twoProjectState(): ProjectsState {
    return makeProjectsState({
      activeId: "project-1",
      projects: [
        {
          id: "project-1",
          label: "alpha",
          path: "/projects/alpha",
          lastUsed: 1,
        },
        {
          id: "project-2",
          label: "beta",
          path: "/projects/beta",
          lastUsed: 1,
        },
      ],
    });
  }

  function projectWithWorkspaceState(): ProjectsState {
    return makeProjectsState({
      activeId: "project-1",
      projects: [
        {
          id: "project-1",
          label: "alpha",
          path: "/projects/alpha",
          lastUsed: 1,
        },
      ],
      workspacesByProject: {
        "project-1": [
          {
            id: "wt-alpha-feature",
            projectId: "project-1",
            path: "/projects/alpha-feature",
            branch: "feature",
            isMain: false,
          },
        ],
      },
    });
  }

  it("preserves overview and spawns a shell when switching projects with the terminal open", () => {
    const newShellTab = vi.fn();
    const { result, stateRef } = renderProjectOps(twoProjectState(), {
      newShellTab,
    });
    const savedAgentTab = nonEmptyAgentTab("beta-agent", "Beta", "project-2");
    result.current.tabBucketsRef.current.set(
      projectScopeBucketKey("project-2", null),
      {
        tabs: [savedAgentTab],
        activeTabId: "beta-agent",
      },
    );
    stateRef.current = {
      ...stateRef.current,
      activeTabId: OVERVIEW_TAB_ID,
      terminal: { open: true },
      tabs: [],
    };

    act(() => {
      expect(result.current.setActiveProjectById("project-2")).toBe(true);
    });

    expect(stateRef.current.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect((stateRef.current.tabs as Tab[]).map((t) => t.id)).toEqual([
      "beta-agent",
    ]);
    expect(newShellTab).toHaveBeenCalledTimes(1);
  });

  it("does not spawn another shell when the destination bucket already has one", () => {
    const newShellTab = vi.fn();
    const { result, stateRef } = renderProjectOps(twoProjectState(), {
      newShellTab,
    });
    const savedShellTab = {
      ...makeEmptyTab("beta-shell", "Shell 1", "project-2", "shell"),
      shell: {
        cwd: "/projects/beta",
        command: "",
        args: [],
        shareMode: "private",
        shellState: "running",
      },
    } as Tab;
    result.current.tabBucketsRef.current.set(
      projectScopeBucketKey("project-2", null),
      {
        tabs: [savedShellTab],
        activeTabId: undefined,
      },
    );
    stateRef.current = {
      ...stateRef.current,
      activeTabId: OVERVIEW_TAB_ID,
      terminal: { open: true },
      tabs: [],
    };

    act(() => {
      expect(result.current.setActiveProjectById("project-2")).toBe(true);
    });

    expect(stateRef.current.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(newShellTab).not.toHaveBeenCalled();
  });

  it("does not spawn an overview shell when switching from an active session", () => {
    const newShellTab = vi.fn();
    const { result, stateRef } = renderProjectOps(twoProjectState(), {
      newShellTab,
    });
    const alphaAgent = nonEmptyAgentTab("alpha-agent", "Alpha", "project-1");
    const betaAgent = nonEmptyAgentTab("beta-agent", "Beta", "project-2");
    result.current.tabBucketsRef.current.set(
      projectScopeBucketKey("project-2", null),
      {
        tabs: [betaAgent],
        activeTabId: "beta-agent",
      },
    );
    stateRef.current = {
      ...stateRef.current,
      activeTabId: "alpha-agent",
      terminal: { open: true },
      tabs: [alphaAgent],
    };

    act(() => {
      expect(result.current.setActiveProjectById("project-2")).toBe(true);
    });

    expect(stateRef.current.activeTabId).toBe("beta-agent");
    expect(newShellTab).not.toHaveBeenCalled();
  });

  it("preserves overview without spawning a shell when the terminal is closed", () => {
    const newShellTab = vi.fn();
    const { result, stateRef } = renderProjectOps(twoProjectState(), {
      newShellTab,
    });
    const betaAgent = nonEmptyAgentTab("beta-agent", "Beta", "project-2");
    result.current.tabBucketsRef.current.set(
      projectScopeBucketKey("project-2", null),
      {
        tabs: [betaAgent],
        activeTabId: "beta-agent",
      },
    );
    stateRef.current = {
      ...stateRef.current,
      activeTabId: OVERVIEW_TAB_ID,
      terminal: { open: false },
      tabs: [],
    };

    act(() => {
      expect(result.current.setActiveProjectById("project-2")).toBe(true);
    });

    expect(stateRef.current.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(newShellTab).not.toHaveBeenCalled();
  });

  it("preserves overview and spawns a shell when clearing to the host bucket", () => {
    const newShellTab = vi.fn();
    const { result, stateRef } = renderProjectOps(twoProjectState(), {
      newShellTab,
    });
    const savedHostAgent = nonEmptyAgentTab("host-agent", "Host", null);
    result.current.tabBucketsRef.current.set(NO_PROJECT_KEY, {
      tabs: [savedHostAgent],
      activeTabId: "host-agent",
    });
    stateRef.current = {
      ...stateRef.current,
      activeTabId: OVERVIEW_TAB_ID,
      terminal: { open: true },
      tabs: [],
    };

    act(() => {
      result.current.clearActiveProject();
    });

    expect(stateRef.current.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect((stateRef.current.tabs as Tab[]).map((t) => t.id)).toEqual([
      "host-agent",
    ]);
    expect(newShellTab).toHaveBeenCalledTimes(1);
  });

  it("does not spawn another shell when clearing to a host bucket with a shell", () => {
    const newShellTab = vi.fn();
    const { result, stateRef } = renderProjectOps(twoProjectState(), {
      newShellTab,
    });
    const savedHostShell = {
      ...makeEmptyTab("host-shell", "Shell 1", null, "shell"),
      shell: {
        cwd: "/projects/aethon",
        command: "",
        args: [],
        shareMode: "private",
        shellState: "running",
      },
    } as Tab;
    result.current.tabBucketsRef.current.set(NO_PROJECT_KEY, {
      tabs: [savedHostShell],
      activeTabId: undefined,
    });
    stateRef.current = {
      ...stateRef.current,
      activeTabId: OVERVIEW_TAB_ID,
      terminal: { open: true },
      tabs: [],
    };

    act(() => {
      result.current.clearActiveProject();
    });

    expect(stateRef.current.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(newShellTab).not.toHaveBeenCalled();
  });

  it("preserves overview and spawns a shell when switching to a workspace", () => {
    const newShellTab = vi.fn();
    const { result, stateRef } = renderProjectOps(projectWithWorkspaceState(), {
      newShellTab,
    });
    const savedWorkspaceAgent = nonEmptyAgentTab(
      "workspace-agent",
      "Workspace",
      "project-1",
      "/projects/alpha-feature",
    );
    result.current.tabBucketsRef.current.set(
      projectScopeBucketKey("project-1", "wt-alpha-feature"),
      {
        tabs: [savedWorkspaceAgent],
        activeTabId: "workspace-agent",
      },
    );
    stateRef.current = {
      ...stateRef.current,
      activeTabId: OVERVIEW_TAB_ID,
      terminal: { open: true },
      tabs: [],
    };

    act(() => {
      result.current.activateWorkspace("wt-alpha-feature");
    });

    expect(stateRef.current.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect((stateRef.current.tabs as Tab[]).map((t) => t.id)).toEqual([
      "workspace-agent",
    ]);
    expect(newShellTab).toHaveBeenCalledTimes(1);
  });

  it("does not spawn another shell when switching to a workspace bucket with a shell", () => {
    const newShellTab = vi.fn();
    const { result, stateRef } = renderProjectOps(projectWithWorkspaceState(), {
      newShellTab,
    });
    const savedWorkspaceShell = {
      ...makeEmptyTab("workspace-shell", "Shell 1", "project-1", "shell"),
      shell: {
        cwd: "/projects/alpha-feature",
        command: "",
        args: [],
        shareMode: "private",
        shellState: "running",
      },
    } as Tab;
    result.current.tabBucketsRef.current.set(
      projectScopeBucketKey("project-1", "wt-alpha-feature"),
      {
        tabs: [savedWorkspaceShell],
        activeTabId: undefined,
      },
    );
    stateRef.current = {
      ...stateRef.current,
      activeTabId: OVERVIEW_TAB_ID,
      terminal: { open: true },
      tabs: [],
    };

    act(() => {
      result.current.activateWorkspace("wt-alpha-feature");
    });

    expect(stateRef.current.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(newShellTab).not.toHaveBeenCalled();
  });
});

describe("useProjectOps workspace refresh", () => {
  it("refreshes workspaces when reselecting a project with cached rows", async () => {
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
        workspacesByProject: { "project-1": [cached] },
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

  it("clears a stale active workspace missing from a fresh git listing", async () => {
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
    const staleWorkspace = {
      id: "wt-deleted",
      projectId: "project-1",
      path: "/projects/aethon-deleted",
      branch: "deleted",
      isMain: false,
    };
    const { result, projectsRef } = renderProjectOps(
      makeProjectsState({
        activeId: "project-1",
        activeWorkspaceId: "wt-deleted",
        workspacesByProject: { "project-1": [staleWorkspace] },
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    projectsRef.current = makeProjectsState({
      activeId: "project-1",
      activeWorkspaceId: "wt-deleted",
      workspacesByProject: { "project-1": [staleWorkspace] },
    });

    await act(async () => {
      await result.current.refreshProjectWorkspaces("project-1");
    });

    expect(projectsRef.current.activeWorkspaceId).toBeNull();
    expect(projectsRef.current.workspacesByProject["project-1"]).toHaveLength(
      1,
    );
    expect(
      projectsRef.current.workspacesByProject["project-1"]?.[0],
    ).toMatchObject({
      path: "/projects/aethon",
      branch: "main",
      isMain: true,
    });
  });

  it("retires tabs and sessions for a workspace pruned by an external worktree removal", async () => {
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
    const externallyRemoved = {
      id: "wt-archived",
      projectId: "project-1",
      path: "/projects/aethon-archived",
      branch: "archived",
      isMain: false,
    };
    const makeInitial = () =>
      makeProjectsState({
        activeId: "project-1",
        activeWorkspaceId: "wt-archived",
        workspacesByProject: { "project-1": [externallyRemoved] },
      });
    const { result, projectsRef, stateRef, closeTabNow } =
      renderProjectOps(makeInitial());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    projectsRef.current = makeInitial();
    const removedKey = projectScopeBucketKey("project-1", "wt-archived");
    stateRef.current = {
      activeTabId: "visible-archived-tab",
      closedSessionIds: [],
      tabs: [
        nonEmptyAgentTab(
          "visible-archived-tab",
          "Archived task",
          "project-1",
          "/projects/aethon-archived",
        ),
      ],
    };
    result.current.tabBucketsRef.current.set(removedKey, {
      activeTabId: "hidden-archived-tab",
      tabs: [
        nonEmptyAgentTab(
          "hidden-archived-tab",
          "Hidden archived task",
          "project-1",
          "/projects/aethon-archived",
        ),
      ],
    });

    await act(async () => {
      await result.current.refreshProjectWorkspaces("project-1");
    });

    // The reconcile prune retires the workspace's tabs exactly like an
    // in-app removal: visible tab closed, stored bucket dropped, hidden
    // session suppressed from auto-restore, worker told to retire.
    expect(closeTabNow).toHaveBeenCalledWith("visible-archived-tab");
    expect(result.current.tabBucketsRef.current.has(removedKey)).toBe(false);
    expect(stateRef.current.closedSessionIds).toContain("hidden-archived-tab");
    expect(harness.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "tab_close",
        tabId: "hidden-archived-tab",
      }),
    });
    expect(projectsRef.current.activeWorkspaceId).toBeNull();
  });
});

describe("useProjectOps workspace creation", () => {
  it("creates workspaces from origin/main by default and activates the result", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation((cmd: string) => {
      if (cmd === "git_worktree_add") {
        return Promise.resolve({
          path: "/tmp/aethon/aethon/fix-thing",
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
            path: "/tmp/aethon/aethon/fix-thing",
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
    const { result, projectsRef, stateRef } = renderProjectOps(initial);
    stateRef.current.aethonRoot = "/tmp/aethon";
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    projectsRef.current = initial;

    await act(async () => {
      const created = await result.current.createWorkspaceWithParams({
        projectId: "project-1",
        branch: "fix/thing",
      });
      expect(created).toBe("/tmp/aethon/aethon/fix-thing");
    });

    expect(harness.invoke).toHaveBeenCalledWith("git_worktree_add", {
      projectPath: "/projects/aethon",
      targetPath: "/tmp/aethon/aethon/fix-thing",
      branch: "fix/thing",
      base: "origin/main",
    });
    expect(projectsRef.current.activeWorkspaceId).toBeTruthy();
    const active = projectsRef.current.workspacesByProject["project-1"]?.find(
      (w) => w.id === projectsRef.current.activeWorkspaceId,
    );
    expect(active?.path).toBe("/tmp/aethon/aethon/fix-thing");
    expect(projectsRef.current.projects[0].uiExpanded).toBe(true);
  });

  it("auto-generates blank workspace branches under the Aethon user dir", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation((cmd: string, args) => {
      if (cmd === "git_branch_list") {
        return Promise.resolve([{ name: "main", current: true }]);
      }
      if (cmd === "git_worktree_add") {
        return Promise.resolve({
          path: args.targetPath,
          branch: args.branch,
          head: "def456",
          isMain: false,
          locked: false,
        });
      }
      if (cmd === "git_worktrees") {
        const addCall = harness.invoke.mock.calls.find(
          ([name]) => name === "git_worktree_add",
        );
        return Promise.resolve([
          {
            path: "/projects/aethon",
            branch: "main",
            head: "abc123",
            isMain: true,
            locked: false,
          },
          {
            path: addCall?.[1]?.targetPath,
            branch: addCall?.[1]?.branch,
            head: "def456",
            isMain: false,
            locked: false,
          },
        ]);
      }
      return Promise.resolve(undefined);
    });
    const initial = makeProjectsState({ activeId: "project-1" });
    const { result, stateRef } = renderProjectOps(initial);
    stateRef.current.aethonRoot = "/tmp/aethon";

    let created: string | null = null;
    await act(async () => {
      created = await result.current.createWorkspaceWithParams({
        projectId: "project-1",
      });
    });

    const addCall = harness.invoke.mock.calls.find(
      ([cmd]) => cmd === "git_worktree_add",
    );
    expect(addCall?.[1]).toMatchObject({
      projectPath: "/projects/aethon",
      base: "origin/main",
    });
    expect(addCall?.[1]?.branch).toMatch(/^feat\//);
    expect(addCall?.[1]?.targetPath).toMatch(/^\/tmp\/aethon\/aethon\/feat-/);
    expect(created).toBe(addCall?.[1]?.targetPath);
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
          workspaceBaseBranch: "upstream/trunk",
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
      await result.current.createWorkspaceWithParams({
        projectId: "project-1",
        branch: "topic",
      });
      await result.current.createWorkspaceWithParams({
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

describe("useProjectOps workspace removal", () => {
  it("closes visible and stored session tabs for the removed workspace", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation((cmd: string) => {
      if (cmd === "git_worktree_remove") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    const workspace = {
      id: "wt-issue",
      projectId: "project-1",
      path: "/projects/aethon-fix-issue",
      branch: "fix/issue",
      isMain: false,
    };
    const initial = makeProjectsState({
      activeId: "project-1",
      activeWorkspaceId: "wt-issue",
      workspacesByProject: {
        "project-1": [
          {
            id: "wt-main",
            projectId: "project-1",
            path: "/projects/aethon",
            branch: "main",
            isMain: true,
          },
          workspace,
        ],
      },
    });
    const { result, projectsRef, stateRef, closeTabNow } =
      renderProjectOps(initial);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    projectsRef.current = initial;
    stateRef.current = {
      activeTabId: "issue-tab",
      tabs: [
        {
          ...makeEmptyTab("issue-tab", "Issue"),
          messages: [],
          projectId: "project-1",
          cwd: "/projects/aethon-fix-issue",
        },
        {
          ...makeEmptyTab("main-tab", "Main"),
          messages: [],
          projectId: "project-1",
          cwd: "/projects/aethon",
        },
      ],
    };
    result.current.tabBucketsRef.current.set(
      projectScopeBucketKey("project-1", "wt-issue"),
      {
        activeTabId: "hidden-issue-tab",
        tabs: [
          {
            ...makeEmptyTab("hidden-issue-tab", "Hidden issue"),
            messages: [],
            projectId: "project-1",
            cwd: "/projects/aethon-fix-issue/",
          },
        ],
      },
    );

    await act(async () => {
      await result.current.removeWorkspaceById("wt-issue", { confirmed: true });
    });

    expect(harness.invoke).toHaveBeenCalledWith("git_worktree_remove", {
      projectPath: "/projects/aethon",
      worktreePath: "/projects/aethon-fix-issue",
      force: false,
    });
    await waitFor(() => expect(closeTabNow).toHaveBeenCalledWith("issue-tab"));
    expect(
      result.current.tabBucketsRef.current.has(
        projectScopeBucketKey("project-1", "wt-issue"),
      ),
    ).toBe(false);
    expect(projectsRef.current.activeWorkspaceId).toBeNull();
    await waitFor(() =>
      expect(
        projectsRef.current.workspacesByProject["project-1"]?.some(
          (wt) => wt.id === "wt-issue",
        ),
      ).toBe(false),
    );
  });

  it("suppresses removed-workspace sessions and closes matching shell tabs", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation(() => Promise.resolve(undefined));
    const workspace = {
      id: "wt-issue",
      projectId: "project-1",
      path: "/projects/aethon-fix-issue",
      branch: "fix/issue",
      isMain: false,
    };
    const initial = makeProjectsState({
      activeId: "project-1",
      activeWorkspaceId: null,
      workspacesByProject: {
        "project-1": [
          {
            id: "wt-main",
            projectId: "project-1",
            path: "/projects/aethon",
            branch: "main",
            isMain: true,
          },
          workspace,
        ],
      },
    });
    const { result, projectsRef, stateRef, closeTabNow } =
      renderProjectOps(initial);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    projectsRef.current = initial;
    const removedKey = projectScopeBucketKey("project-1", "wt-issue");
    stateRef.current = {
      activeTabId: "shell-tab",
      closedSessionIds: [],
      tabs: [
        {
          ...makeEmptyTab("shell-tab", "Shell", "project-1", "shell"),
          cwd: "/projects/aethon-fix-issue",
        },
      ],
      persistedTabBuckets: {
        [removedKey]: {
          activeTabId: "persisted-issue-tab",
          tabs: [
            {
              ...makeEmptyTab("persisted-issue-tab", "Persisted"),
              projectId: "project-1",
              cwd: "/projects/aethon-fix-issue",
            },
          ],
        },
      },
    };
    result.current.tabBucketsRef.current.set(removedKey, {
      activeTabId: "hidden-issue-tab",
      tabs: [
        {
          ...makeEmptyTab("hidden-issue-tab", "Hidden issue"),
          projectId: "project-1",
          cwd: "/projects/aethon-fix-issue",
        },
      ],
    });

    await act(async () => {
      await result.current.removeWorkspaceById("wt-issue", { confirmed: true });
    });

    // The shell tab anchored in the removed worktree closes with it.
    await waitFor(() => expect(closeTabNow).toHaveBeenCalledWith("shell-tab"));
    // Hidden bucket sessions are suppressed from discovery auto-restore
    // and their background workers are told to retire.
    await waitFor(() =>
      expect(stateRef.current.closedSessionIds).toContain("hidden-issue-tab"),
    );
    expect(stateRef.current.closedSessionIds).toContain("persisted-issue-tab");
    expect(
      (stateRef.current.persistedTabBuckets as Record<string, unknown>)[
        removedKey
      ],
    ).toBeUndefined();
    expect(harness.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({ type: "tab_close", tabId: "hidden-issue-tab" }),
    });
  });

  it("marks the row as removing before a delayed git removal resolves", async () => {
    const harness = installTauriMocks();
    const removal = deferred<void>();
    harness.invoke.mockImplementation((cmd: string) => {
      if (cmd === "git_worktree_remove") return removal.promise;
      return Promise.resolve(undefined);
    });
    const initial = makeProjectsState({
      activeId: "project-1",
      activeWorkspaceId: "wt-issue",
      workspacesByProject: {
        "project-1": [
          {
            id: "wt-main",
            projectId: "project-1",
            path: "/projects/aethon",
            branch: "main",
            isMain: true,
          },
          {
            id: "wt-issue",
            projectId: "project-1",
            path: "/projects/aethon-fix-issue",
            branch: "fix/issue",
            isMain: false,
          },
          {
            id: "wt-other",
            projectId: "project-1",
            path: "/projects/aethon-other",
            branch: "other",
            isMain: false,
          },
        ],
      },
    });
    const { result, projectsRef } = renderProjectOps(initial);
    await act(async () => {
      await Promise.resolve();
    });
    projectsRef.current = initial;

    await act(async () => {
      await result.current.removeWorkspaceById("wt-issue", { confirmed: true });
    });

    expect(harness.invoke).toHaveBeenCalledWith("git_worktree_remove", {
      projectPath: "/projects/aethon",
      worktreePath: "/projects/aethon-fix-issue",
      force: false,
    });
    expect(
      projectsRef.current.workspacesByProject["project-1"]?.find(
        (wt) => wt.id === "wt-issue",
      )?.pendingState,
    ).toBe("removing");

    await act(async () => {
      await result.current.removeWorkspaceById("wt-issue", { confirmed: true });
    });
    expect(
      harness.invoke.mock.calls.filter(
        ([cmd]) => cmd === "git_worktree_remove",
      ),
    ).toHaveLength(1);

    projectsRef.current = {
      ...projectsRef.current,
      activeWorkspaceId: "wt-other",
    };

    await act(async () => {
      removal.resolve();
      await removal.promise;
    });
    await waitFor(() =>
      expect(
        projectsRef.current.workspacesByProject["project-1"]?.some(
          (wt) => wt.id === "wt-issue",
        ),
      ).toBe(false),
    );
    expect(projectsRef.current.activeWorkspaceId).toBe("wt-other");
  });

  it("restores the row if dirty removal is not forced", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation(
      (cmd: string, args?: { force?: boolean }) => {
        if (cmd === "git_worktree_remove" && args?.force === true) {
          return Promise.resolve(undefined);
        }
        if (cmd === "git_worktree_remove") {
          return Promise.reject(new Error("workspace contains modified files"));
        }
        return Promise.resolve(undefined);
      },
    );
    const forcePrompt = deferred<boolean>();
    const promptForceRemove = vi.fn(() => forcePrompt.promise);
    const initial = makeProjectsState({
      activeId: "project-1",
      activeWorkspaceId: "wt-issue",
      workspacesByProject: {
        "project-1": [
          {
            id: "wt-main",
            projectId: "project-1",
            path: "/projects/aethon",
            branch: "main",
            isMain: true,
          },
          {
            id: "wt-issue",
            projectId: "project-1",
            path: "/projects/aethon-fix-issue",
            branch: "fix/issue",
            isMain: false,
          },
        ],
      },
    });
    const { result, projectsRef, stateRef, closeTabNow } = renderProjectOps(
      initial,
      {
        workspacePrompts: {
          promptRemoveWorkspace: vi.fn(() => Promise.resolve(true)),
          promptForceRemove,
          promptOrphanCleanup: vi.fn(() => Promise.resolve(true)),
          notifyCannotRemoveMain: vi.fn(),
          notifyFailure: vi.fn(),
        },
      },
    );
    await act(async () => {
      await Promise.resolve();
    });
    projectsRef.current = initial;
    stateRef.current = {
      activeTabId: "issue-tab",
      tabs: [
        {
          ...makeEmptyTab("issue-tab", "Issue"),
          messages: [],
          projectId: "project-1",
          cwd: "/projects/aethon-fix-issue",
        },
      ],
    };

    await act(async () => {
      await result.current.removeWorkspaceById("wt-issue", { confirmed: true });
    });
    await waitFor(() => expect(promptForceRemove).toHaveBeenCalledTimes(1));
    expect(
      projectsRef.current.workspacesByProject["project-1"]?.find(
        (wt) => wt.id === "wt-issue",
      )?.pendingState,
    ).toBe("removing");
    expect(projectsRef.current.activeWorkspaceId).toBe("wt-issue");
    expect(closeTabNow).not.toHaveBeenCalled();

    await act(async () => {
      forcePrompt.resolve(false);
      await forcePrompt.promise;
    });
    expect(harness.invoke).not.toHaveBeenCalledWith(
      "git_worktree_remove",
      expect.objectContaining({ force: true }),
    );
    await waitFor(() =>
      expect(
        projectsRef.current.workspacesByProject["project-1"]?.some(
          (wt) => wt.id === "wt-issue",
        ),
      ).toBe(true),
    );
    expect(projectsRef.current.activeWorkspaceId).toBe("wt-issue");
    expect(closeTabNow).not.toHaveBeenCalled();
  });

  it("falls through to the orphan command when git reports 'workspace not tracked'", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation((cmd: string) => {
      if (cmd === "git_worktree_remove")
        return Promise.reject(
          new Error("workspace not tracked: /projects/aethon-fix-issue"),
        );
      if (cmd === "git_worktree_remove_orphan")
        return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    const initial = makeProjectsState({
      activeId: "project-1",
      activeWorkspaceId: "wt-issue",
      workspacesByProject: {
        "project-1": [
          {
            id: "wt-main",
            projectId: "project-1",
            path: "/projects/aethon",
            branch: "main",
            isMain: true,
          },
          {
            id: "wt-issue",
            projectId: "project-1",
            path: "/projects/aethon-fix-issue",
            branch: "fix/issue",
            isMain: false,
          },
        ],
      },
    });
    const { result, projectsRef, workspacePrompts } = renderProjectOps(initial);
    await act(async () => {
      await Promise.resolve();
    });
    projectsRef.current = initial;
    await act(async () => {
      await result.current.removeWorkspaceById("wt-issue", { confirmed: true });
    });
    await waitFor(() =>
      expect(workspacePrompts.promptOrphanCleanup).toHaveBeenCalledTimes(1),
    );
    expect(harness.invoke).toHaveBeenCalledWith("git_worktree_remove_orphan", {
      projectPath: "/projects/aethon",
      worktreePath: "/projects/aethon-fix-issue",
    });
    expect(workspacePrompts.notifyFailure).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        projectsRef.current.workspacesByProject["project-1"]?.some(
          (wt) => wt.id === "wt-issue",
        ),
      ).toBe(false),
    );
  });

  it("aborts cleanly if the user declines the orphan confirmation", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation((cmd: string) => {
      if (cmd === "git_worktree_remove")
        return Promise.reject(
          new Error("workspace not tracked: /projects/aethon-fix-issue"),
        );
      return Promise.resolve(undefined);
    });
    const initial = makeProjectsState({
      activeId: "project-1",
      workspacesByProject: {
        "project-1": [
          {
            id: "wt-main",
            projectId: "project-1",
            path: "/projects/aethon",
            branch: "main",
            isMain: true,
          },
          {
            id: "wt-issue",
            projectId: "project-1",
            path: "/projects/aethon-fix-issue",
            branch: "fix/issue",
            isMain: false,
          },
        ],
      },
    });
    const promptOrphanCleanup = vi.fn(() => Promise.resolve(false));
    const { result, projectsRef, workspacePrompts } = renderProjectOps(
      initial,
      {
        workspacePrompts: {
          promptRemoveWorkspace: vi.fn(() => Promise.resolve(true)),
          promptForceRemove: vi.fn(() => Promise.resolve(true)),
          promptOrphanCleanup,
          notifyCannotRemoveMain: vi.fn(),
          notifyFailure: vi.fn(),
        },
      },
    );
    await act(async () => {
      await Promise.resolve();
    });
    projectsRef.current = initial;
    await act(async () => {
      await result.current.removeWorkspaceById("wt-issue", { confirmed: true });
    });
    await waitFor(() =>
      expect(workspacePrompts.promptOrphanCleanup).toHaveBeenCalledTimes(1),
    );
    expect(harness.invoke).not.toHaveBeenCalledWith(
      "git_worktree_remove_orphan",
      expect.anything(),
    );
    expect(workspacePrompts.notifyFailure).not.toHaveBeenCalled();
    // Row is restored so the user can try again later.
    await waitFor(() =>
      expect(
        projectsRef.current.workspacesByProject["project-1"]?.some(
          (wt) => wt.id === "wt-issue",
        ),
      ).toBe(true),
    );
  });

  it("alerts when the orphan command itself fails", async () => {
    const harness = installTauriMocks();
    harness.invoke.mockImplementation((cmd: string) => {
      if (cmd === "git_worktree_remove")
        return Promise.reject(new Error("workspace not tracked: x"));
      if (cmd === "git_worktree_remove_orphan")
        return Promise.reject(new Error("trash: permission denied"));
      return Promise.resolve(undefined);
    });
    const initial = makeProjectsState({
      activeId: "project-1",
      workspacesByProject: {
        "project-1": [
          {
            id: "wt-main",
            projectId: "project-1",
            path: "/projects/aethon",
            branch: "main",
            isMain: true,
          },
          {
            id: "wt-issue",
            projectId: "project-1",
            path: "/projects/aethon-fix-issue",
            branch: "fix/issue",
            isMain: false,
          },
        ],
      },
    });
    const { result, projectsRef, workspacePrompts } = renderProjectOps(initial);
    await act(async () => {
      await Promise.resolve();
    });
    projectsRef.current = initial;
    await act(async () => {
      await result.current.removeWorkspaceById("wt-issue", { confirmed: true });
    });
    await waitFor(() =>
      expect(workspacePrompts.notifyFailure).toHaveBeenCalledWith(
        "Error: trash: permission denied",
      ),
    );
    // Row is restored so a follow-up attempt is possible.
    expect(
      projectsRef.current.workspacesByProject["project-1"]?.some(
        (wt) => wt.id === "wt-issue",
      ),
    ).toBe(true);
  });
});
