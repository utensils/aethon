import { describe, expect, it, vi } from "vitest";
import { handleDashboardQuery } from "./dashboardQuery";
import { buildHandlerFixture } from "./testFixtures";

const flushPromises = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("handleDashboardQuery", () => {
  it("resolves start_task project paths from known workspace roots", async () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: {
        sidebar: {
          models: [{ id: "openai-codex/gpt-5.5", label: "GPT-5.5" }],
        },
      },
    });
    const startTaskInProject = vi.fn(() =>
      Promise.resolve({
        tabId: "tab-bg",
        projectId: "p1",
        cwd: "/repo/aethon-work",
        activated: false,
      }),
    );
    ctx.startTaskInProject = startTaskInProject;
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorkspaceId: null,
      activeHostId: null,
      projects: [
        { id: "p1", label: "Aethon", path: "/repo/aethon", lastUsed: 1 },
      ],
      workspacesByProject: {
        p1: [
          {
            id: "wt-1",
            projectId: "p1",
            path: "/repo/aethon-work",
            branch: "feat/work",
            isMain: false,
          },
        ],
      },
    };

    handleDashboardQuery(
      {
        type: "dashboard_query",
        mutationId: "m1",
        op: "start_task",
        args: {
          projectPath: "/repo/aethon-work",
          prompt: "review this",
          model: "openai-codex/gpt-5.5",
          activate: false,
        },
      },
      ctx,
    );
    await flushPromises();

    expect(startTaskInProject).toHaveBeenCalledWith({
      projectId: "p1",
      workspaceId: "wt-1",
      prompt: "review this",
      newWorkspace: false,
      branch: undefined,
      baseBranch: undefined,
      model: "openai-codex/gpt-5.5",
      activate: false,
    });
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m1",
      true,
      undefined,
      expect.objectContaining({
        ok: true,
        projectId: "p1",
        tabId: "tab-bg",
        cwd: "/repo/aethon-work",
      }),
    );
  });

  it("rejects unknown start_task models before creating a session", async () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: {
        sidebar: {
          models: [
            { id: "openai-codex/gpt-5.5", label: "GPT-5.5" },
            { id: "github-copilot/gpt-5.5", label: "Copilot: GPT-5.5" },
          ],
        },
      },
    });
    const startTaskInProject = vi.fn(() =>
      Promise.resolve({
        tabId: "tab-bg",
        projectId: "p1",
        cwd: "/repo/aethon",
        activated: false,
      }),
    );
    ctx.startTaskInProject = startTaskInProject;
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorkspaceId: null,
      activeHostId: null,
      projects: [
        { id: "p1", label: "Aethon", path: "/repo/aethon", lastUsed: 1 },
      ],
      workspacesByProject: {},
    };

    handleDashboardQuery(
      {
        type: "dashboard_query",
        mutationId: "m1",
        op: "start_task",
        args: {
          projectPath: "/repo/aethon",
          prompt: "review this",
          model: "gpt-5.5",
        },
      },
      ctx,
    );
    await flushPromises();

    expect(startTaskInProject).not.toHaveBeenCalled();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m1",
      false,
      "Unknown model id 'gpt-5.5'. Use one of: openai-codex/gpt-5.5, github-copilot/gpt-5.5.",
    );
  });

  it("rejects missing start_task models before creating a session", async () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: {
        sidebar: {
          models: [
            { id: "openai-codex/gpt-5.5", label: "GPT-5.5" },
            { id: "github-copilot/gpt-5.5", label: "Copilot: GPT-5.5" },
          ],
        },
      },
    });
    const startTaskInProject = vi.fn(() =>
      Promise.resolve({
        tabId: "tab-bg",
        projectId: "p1",
        cwd: "/repo/aethon",
        activated: false,
      }),
    );
    ctx.startTaskInProject = startTaskInProject;
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorkspaceId: null,
      activeHostId: null,
      projects: [
        { id: "p1", label: "Aethon", path: "/repo/aethon", lastUsed: 1 },
      ],
      workspacesByProject: {},
    };

    handleDashboardQuery(
      {
        type: "dashboard_query",
        mutationId: "m1",
        op: "start_task",
        args: {
          projectPath: "/repo/aethon",
          prompt: "review this",
        },
      },
      ctx,
    );
    await flushPromises();

    expect(startTaskInProject).not.toHaveBeenCalled();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m1",
      false,
      "start_task requires an explicit provider-qualified model id. Use one of: openai-codex/gpt-5.5, github-copilot/gpt-5.5.",
    );
  });
});
