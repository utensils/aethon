// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectsState } from "../projects";
import { useTaskLauncher } from "./useTaskLauncher";
import type { NotificationInput } from "./useNotifications";

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
    activeWorktreeId: null,
    worktreesByProject: {},
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
        createWorktreeWithParams: vi.fn(),
        activateWorktree: vi.fn(),
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

  it("creates a worktree tab and sends the initial task prompt", async () => {
    const projects = makeProjects();
    projects.worktreesByProject.p1 = [
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
    const createWorktreeWithParams = vi.fn(() =>
      Promise.resolve("/repo/aethon-task"),
    );
    const activateWorktree = vi.fn();
    const newTab = vi.fn();
    const sendChat = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef,
        pushNotificationRef: ref((_: NotificationInput) => {}),
        setActiveProjectById,
        createWorktreeWithParams,
        activateWorktree,
        newTab,
        pendingTabOpens: ref(new Map()),
        sendChat,
      }),
    );

    await act(async () => {
      await result.current({
        projectId: "p1",
        prompt: "  implement this  ",
        newWorktree: true,
        branch: "feat/task",
        baseBranch: "main",
      });
    });

    const tabId = newTab.mock.calls[0]?.[0];
    expect(setActiveProjectById).toHaveBeenCalledWith("p1");
    expect(createWorktreeWithParams).toHaveBeenCalledWith({
      projectId: "p1",
      branch: "feat/task",
      baseBranch: "main",
    });
    expect(activateWorktree).toHaveBeenCalledWith("wt-1");
    expect(newTab).toHaveBeenCalledWith(tabId, undefined, {
      cwd: "/repo/aethon-task",
    });
    expect(sendChat).toHaveBeenCalledWith("implement this", { tabId });
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
        createWorktreeWithParams: vi.fn(),
        activateWorktree: vi.fn(),
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

  it("uses automatic worktree naming when the launcher branch is blank", async () => {
    const projects = makeProjects();
    projects.worktreesByProject.p1 = [
      {
        id: "wt-auto",
        projectId: "p1",
        path: "/tmp/aethon/aethon/feat-aurora",
        branch: "feat/aurora",
        isMain: false,
      },
    ];
    const projectsRef = ref(projects);
    const createWorktreeWithParams = vi.fn(() =>
      Promise.resolve("/tmp/aethon/aethon/feat-aurora"),
    );
    const activateWorktree = vi.fn();
    const newTab = vi.fn();
    const sendChat = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useTaskLauncher({
        projectsRef,
        pushNotificationRef: ref((_: NotificationInput) => {}),
        setActiveProjectById: vi.fn(() => true),
        createWorktreeWithParams,
        activateWorktree,
        newTab,
        pendingTabOpens: ref(new Map()),
        sendChat,
      }),
    );

    await act(async () => {
      await result.current({
        projectId: "p1",
        prompt: "  implement this  ",
        newWorktree: true,
        branch: "   ",
      });
    });

    expect(createWorktreeWithParams).toHaveBeenCalledWith({
      projectId: "p1",
      baseBranch: undefined,
    });
    expect(activateWorktree).toHaveBeenCalledWith("wt-auto");
  });
});
