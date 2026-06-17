import { describe, expect, it, vi } from "vitest";
import { handleDashboardQuery } from "./dashboardQuery";
import { buildHandlerFixture } from "./testFixtures";

const flushPromises = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("handleDashboardQuery", () => {
  it("resolves start_task project paths from known workspace roots", async () => {
    const { ctx, mocks } = buildHandlerFixture();
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
});
