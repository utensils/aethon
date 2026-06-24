// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectsState } from "../projects";
import { makeEmptyTab, type Tab } from "../types/tab";
import { useTaskLauncher } from "./useTaskLauncher";
import type { NotificationInput } from "./useNotifications";
import type { TabBucket } from "./projectOps/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

const ref = <T,>(value: T) => ({ current: value });

function makeProjects(): ProjectsState {
  return {
    projects: [
      {
        id: "p1",
        label: "Aethon",
        path: "/repo/aethon",
        lastUsed: 1,
      },
    ],
    activeId: null,
    activeWorkspaceId: null,
    workspacesByProject: {},
    activeHostId: null,
  };
}

describe("useTaskLauncher", () => {
  it("warns when the selected project no longer exists", async () => {
    const pushNotification = vi.fn();
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef: ref({ ...makeProjects(), projects: [] }),
        pushNotificationRef: ref(pushNotification),
        setActiveProjectById: vi.fn(),
        createWorkspaceWithParams: vi.fn(),
        activateWorkspace: vi.fn(),
        newTab: vi.fn(),
        pendingTabOpens: ref(new Map()),
        sendChat: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current({ projectId: "missing", prompt: "hello" });
    });

    expect(pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not start task" }),
    );
  });

  it("creates a workspace tab and sends the initial task prompt", async () => {
    const projects = makeProjects();
    projects.workspacesByProject.p1 = [
      {
        id: "wt-1",
        projectId: "p1",
        path: "/repo/aethon-task",
        branch: "feat/task",
        isMain: false,
      },
    ];
    const projectsRef = ref(projects);
    const setActiveProjectById = vi.fn((id: string) => {
      projectsRef.current.activeId = id;
      return true;
    });
    const createWorkspaceWithParams = vi.fn(() =>
      Promise.resolve("/repo/aethon-task"),
    );
    const activateWorkspace = vi.fn();
    const newTab = vi.fn();
    const sendChat = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef,
        pushNotificationRef: ref((_: NotificationInput) => {}),
        setActiveProjectById,
        createWorkspaceWithParams,
        activateWorkspace,
        newTab,
        pendingTabOpens: ref(new Map()),
        sendChat,
      }),
    );

    await act(async () => {
      await result.current({
        projectId: "p1",
        prompt: "  implement this  ",
        newWorkspace: true,
        branch: "feat/task",
        baseBranch: "main",
      });
    });

    const tabId = newTab.mock.calls[0]?.[0];
    expect(setActiveProjectById).toHaveBeenCalledWith("p1");
    expect(createWorkspaceWithParams).toHaveBeenCalledWith({
      projectId: "p1",
      branch: "feat/task",
      baseBranch: "main",
      activate: true,
    });
    expect(activateWorkspace).toHaveBeenCalledWith("wt-1");
    expect(newTab).toHaveBeenCalledWith(tabId, undefined, {
      cwd: "/repo/aethon-task",
    });
    expect(sendChat).toHaveBeenCalledWith("implement this", { tabId });
  });

  it("attaches GitHub issue source metadata to active task tabs", async () => {
    const projects = makeProjects();
    projects.workspacesByProject.p1 = [
      {
        id: "wt-85",
        projectId: "p1",
        path: "/repo/aethon-issue-85",
        branch: "fix/issue-85-existing",
        isMain: false,
      },
    ];
    const projectsRef = ref(projects);
    const newTab = vi.fn();
    const sendChat = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef,
        pushNotificationRef: ref((_: NotificationInput) => {}),
        setActiveProjectById: vi.fn(() => true),
        createWorkspaceWithParams: vi.fn(() =>
          Promise.resolve("/repo/aethon-issue-85"),
        ),
        activateWorkspace: vi.fn(),
        newTab,
        pendingTabOpens: ref(new Map()),
        sendChat,
      }),
    );

    await act(async () => {
      await result.current({
        projectId: "p1",
        prompt: "fix issue",
        newWorkspace: true,
        branch: "fix/issue-85-existing",
        sourceIssue: {
          kind: "github-issue",
          projectId: "p1",
          number: 85,
          url: "https://github.com/utensils/aethon/issues/85",
          title: "Cannot rename session tab while agent is running",
          createdAt: 1,
        },
      });
    });

    const tabId = newTab.mock.calls[0]?.[0];
    expect(newTab).toHaveBeenCalledWith(tabId, undefined, {
      cwd: "/repo/aethon-issue-85",
      sourceIssue: expect.objectContaining({
        kind: "github-issue",
        number: 85,
        branch: "fix/issue-85-existing",
        workspaceId: "wt-85",
        workspacePath: "/repo/aethon-issue-85",
      }),
    });
  });

  it("threads the per-launch model through to the new tab", async () => {
    const projectsRef = ref(makeProjects());
    const newTab = vi.fn();
    const sendChat = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef,
        pushNotificationRef: ref((_: NotificationInput) => {}),
        setActiveProjectById: vi.fn(() => true),
        createWorkspaceWithParams: vi.fn(),
        activateWorkspace: vi.fn(),
        newTab,
        pendingTabOpens: ref(new Map()),
        sendChat,
      }),
    );

    await act(async () => {
      await result.current({
        projectId: "p1",
        prompt: "do the thing",
        model: "openai/gpt-5.5",
      });
    });

    const tabId = newTab.mock.calls[0]?.[0];
    expect(newTab).toHaveBeenCalledWith(tabId, undefined, {
      cwd: "/repo/aethon",
      model: "openai/gpt-5.5",
    });
    expect(sendChat).toHaveBeenCalledWith("do the thing", { tabId });
  });

  it("uses automatic workspace naming when the launcher branch is blank", async () => {
    const projects = makeProjects();
    projects.workspacesByProject.p1 = [
      {
        id: "wt-auto",
        projectId: "p1",
        path: "/tmp/aethon/aethon/feat-aurora",
        branch: "feat/aurora",
        isMain: false,
      },
    ];
    const projectsRef = ref(projects);
    const createWorkspaceWithParams = vi.fn(() =>
      Promise.resolve("/tmp/aethon/aethon/feat-aurora"),
    );
    const activateWorkspace = vi.fn();
    const newTab = vi.fn();
    const sendChat = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef,
        pushNotificationRef: ref((_: NotificationInput) => {}),
        setActiveProjectById: vi.fn(() => true),
        createWorkspaceWithParams,
        activateWorkspace,
        newTab,
        pendingTabOpens: ref(new Map()),
        sendChat,
      }),
    );

    await act(async () => {
      await result.current({
        projectId: "p1",
        prompt: "  implement this  ",
        newWorkspace: true,
        branch: "   ",
      });
    });

    expect(createWorkspaceWithParams).toHaveBeenCalledWith({
      projectId: "p1",
      baseBranch: undefined,
      activate: true,
    });
    expect(activateWorkspace).toHaveBeenCalledWith("wt-auto");
  });

  it("creates background workspace tabs without requesting workspace activation", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const projects = makeProjects();
    projects.activeId = "p1";
    projects.workspacesByProject.p1 = [
      {
        id: "wt-bg",
        projectId: "p1",
        path: "/repo/aethon-bg",
        branch: "feat/bg",
        isMain: false,
      },
    ];
    const stateRef = ref<Record<string, unknown>>({
      activeTabId: "main",
      tabs: [makeEmptyTab("main", "Main", "p1", "agent")],
    });
    const setState = vi.fn((arg: unknown) => {
      stateRef.current =
        typeof arg === "function"
          ? (arg as (prev: Record<string, unknown>) => Record<string, unknown>)(
              stateRef.current,
            )
          : (arg as Record<string, unknown>);
    });
    const createWorkspaceWithParams = vi.fn(() =>
      Promise.resolve("/repo/aethon-bg"),
    );
    const setActiveProjectById = vi.fn(() => true);
    const activateWorkspace = vi.fn();
    const sendChat = vi.fn(() => Promise.resolve());
    const tabBucketsRef = ref(new Map<string, TabBucket>());
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef: ref(projects),
        pushNotificationRef: ref((_: NotificationInput) => {}),
        setActiveProjectById,
        createWorkspaceWithParams,
        activateWorkspace,
        newTab: vi.fn(),
        pendingTabOpens: ref(new Map()),
        sendChat,
        setState,
        stateRef,
        tabBucketsRef,
        piDefaultModelRef: ref("openai/gpt-5"),
      }),
    );

    await act(async () => {
      await result.current({
        projectId: "p1",
        prompt: "background workspace review",
        newWorkspace: true,
        branch: "feat/bg",
        activate: false,
      });
    });

    expect(createWorkspaceWithParams).toHaveBeenCalledWith({
      projectId: "p1",
      branch: "feat/bg",
      baseBranch: undefined,
      activate: false,
    });
    expect(setActiveProjectById).not.toHaveBeenCalled();
    expect(activateWorkspace).not.toHaveBeenCalled();
    expect(stateRef.current.activeTabId).toBe("main");
    const bucket = tabBucketsRef.current.get("p1::workspace::wt-bg");
    expect(bucket?.tabs[0]).toMatchObject({
      projectId: "p1",
      cwd: "/repo/aethon-bg",
    });
    expect(sendChat).toHaveBeenCalledWith("background workspace review", {
      tabId: bucket?.tabs[0]?.id,
    });
  });

  it("adds an inactive task tab to the active bucket without focusing it", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const existing = makeEmptyTab("existing", "Existing", "p1", "agent");
    const stateRef = ref<Record<string, unknown>>({
      activeTabId: "existing",
      tabs: [existing],
      defaultModel: "openai/gpt-5.5",
    });
    const setState = vi.fn((arg: unknown) => {
      stateRef.current =
        typeof arg === "function"
          ? (arg as (prev: Record<string, unknown>) => Record<string, unknown>)(
              stateRef.current,
            )
          : (arg as Record<string, unknown>);
    });
    const projects = makeProjects();
    projects.activeId = "p1";
    const newTab = vi.fn();
    const setActiveProjectById = vi.fn(() => true);
    const activateWorkspace = vi.fn();
    const sendChat = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef: ref(projects),
        pushNotificationRef: ref((_: NotificationInput) => {}),
        setActiveProjectById,
        createWorkspaceWithParams: vi.fn(),
        activateWorkspace,
        newTab,
        pendingTabOpens: ref(new Map()),
        sendChat,
        setState,
        stateRef,
        tabBucketsRef: ref(new Map<string, TabBucket>()),
        piDefaultModelRef: ref("openai/gpt-5"),
      }),
    );

    await act(async () => {
      await result.current({
        projectId: "p1",
        prompt: "background review",
        activate: false,
        label: "Kimi review",
      });
    });

    const tabs = stateRef.current.tabs as Tab[];
    const created = tabs.find((tab) => tab.id !== "existing");
    expect(created).toMatchObject({
      label: "Kimi review",
      projectId: "p1",
      cwd: "/repo/aethon",
      model: "openai/gpt-5.5",
    });
    expect(stateRef.current.activeTabId).toBe("existing");
    expect(setActiveProjectById).not.toHaveBeenCalled();
    expect(activateWorkspace).not.toHaveBeenCalled();
    expect(newTab).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledWith("background review", {
      tabId: created?.id,
    });
  });

  it("does not count an active-bucket snapshot twice when naming background tabs", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const existing = makeEmptyTab("existing", "Existing", "p1", "agent");
    const stateRef = ref<Record<string, unknown>>({
      activeTabId: "existing",
      tabs: [existing],
    });
    const setState = vi.fn((arg: unknown) => {
      stateRef.current =
        typeof arg === "function"
          ? (arg as (prev: Record<string, unknown>) => Record<string, unknown>)(
              stateRef.current,
            )
          : (arg as Record<string, unknown>);
    });
    const projects = makeProjects();
    projects.activeId = "p1";
    const tabBucketsRef = ref(
      new Map<string, TabBucket>([
        ["p1", { tabs: [existing], activeTabId: "existing" }],
      ]),
    );
    const sendChat = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef: ref(projects),
        pushNotificationRef: ref((_: NotificationInput) => {}),
        setActiveProjectById: vi.fn(() => true),
        createWorkspaceWithParams: vi.fn(),
        activateWorkspace: vi.fn(),
        newTab: vi.fn(),
        pendingTabOpens: ref(new Map()),
        sendChat,
        setState,
        stateRef,
        tabBucketsRef,
        piDefaultModelRef: ref("openai/gpt-5"),
      }),
    );

    await act(async () => {
      await result.current({
        projectId: "p1",
        prompt: "background review",
        activate: false,
      });
    });

    const created = (stateRef.current.tabs as Tab[]).find(
      (tab) => tab.id !== "existing",
    );
    expect(created?.label).toBe("Tab 2");
  });

  it("adds an inactive task tab to a stashed workspace bucket", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const stateRef = ref<Record<string, unknown>>({
      activeTabId: "main",
      tabs: [makeEmptyTab("main", "Main", "p1", "agent")],
    });
    const setState = vi.fn((arg: unknown) => {
      stateRef.current =
        typeof arg === "function"
          ? (arg as (prev: Record<string, unknown>) => Record<string, unknown>)(
              stateRef.current,
            )
          : (arg as Record<string, unknown>);
    });
    const projects = makeProjects();
    projects.activeId = "p1";
    projects.projects.push({
      id: "p2",
      label: "Other",
      path: "/repo/other",
      lastUsed: 2,
    });
    projects.workspacesByProject.p2 = [
      {
        id: "wt-2",
        projectId: "p2",
        path: "/repo/other-work",
        branch: "feat/other",
        isMain: false,
      },
    ];
    const tabBucketsRef = ref(new Map<string, TabBucket>());
    const setActiveProjectById = vi.fn(() => true);
    const activateWorkspace = vi.fn();
    const sendChat = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef: ref(projects),
        pushNotificationRef: ref((_: NotificationInput) => {}),
        setActiveProjectById,
        createWorkspaceWithParams: vi.fn(),
        activateWorkspace,
        newTab: vi.fn(),
        pendingTabOpens: ref(new Map()),
        sendChat,
        setState,
        stateRef,
        tabBucketsRef,
        piDefaultModelRef: ref("openai/gpt-5"),
      }),
    );

    await act(async () => {
      await result.current({
        projectId: "p2",
        workspaceId: "wt-2",
        prompt: "background workspace task",
        activate: false,
        label: "GLM task",
        sourceIssue: {
          kind: "github-issue",
          projectId: "p2",
          number: 52,
          url: "https://github.com/example/other/issues/52",
          title: "Background issue",
          createdAt: 1,
        },
      });
    });

    expect(setActiveProjectById).not.toHaveBeenCalled();
    expect(activateWorkspace).not.toHaveBeenCalled();
    expect(stateRef.current.activeTabId).toBe("main");
    const bucket = tabBucketsRef.current.get("p2::workspace::wt-2");
    expect(bucket?.activeTabId).toBe(bucket?.tabs[0]?.id);
    expect(bucket?.tabs[0]).toMatchObject({
      label: "GLM task",
      projectId: "p2",
      cwd: "/repo/other-work",
      sourceIssue: {
        kind: "github-issue",
        projectId: "p2",
        number: 52,
        workspaceId: "wt-2",
        workspacePath: "/repo/other-work",
        branch: "feat/other",
      },
    });
    expect(
      (stateRef.current.persistedTabBuckets as Record<string, TabBucket>)[
        "p2::workspace::wt-2"
      ].tabs[0]?.id,
    ).toBe(bucket?.tabs[0]?.id);
    expect(sendChat).toHaveBeenCalledWith("background workspace task", {
      tabId: bucket?.tabs[0]?.id,
    });
  });
});
