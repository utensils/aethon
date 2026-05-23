import { describe, expect, it } from "vitest";
import {
  handleGhStatsStrip,
  handleProjectDashboard,
  handleProjectsDashboard,
  handleTaskLauncher,
} from "./dashboard";
import { buildRouteFixture } from "./testFixtures";

describe("handleProjectsDashboard", () => {
  it("new-tab calls ctx.newTab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleProjectsDashboard(
      { component: { id: "projects-dashboard", type: "projects-dashboard" }, eventType: "new-tab" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.newTab).toHaveBeenCalledTimes(1);
  });

  it("open-project calls openProjectFromPicker", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleProjectsDashboard(
      { component: { id: "x", type: "projects-dashboard" }, eventType: "open-project" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.openProjectFromPicker).toHaveBeenCalledTimes(1);
  });

  it("select-project-card activates the project", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleProjectsDashboard(
      {
        component: { id: "x", type: "projects-dashboard" },
        eventType: "select-project-card",
        data: { projectId: "p1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.setActiveProjectById).toHaveBeenCalledWith("p1");
  });

  it("remove-project-card removes by id", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleProjectsDashboard(
      {
        component: { id: "x", type: "projects-dashboard" },
        eventType: "remove-project-card",
        data: { projectId: "p1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.removeProjectById).toHaveBeenCalledWith("p1");
  });

  it("restore-session opens the tab with restoredSession=true", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleProjectsDashboard(
      {
        component: { id: "x", type: "projects-dashboard" },
        eventType: "restore-session",
        data: { sessionId: "tab-42", label: "Earlier", cwd: "/p" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.newTab).toHaveBeenCalledWith("tab-42", "Earlier", {
      restoredSession: true,
      cwd: "/p",
    });
  });
});

describe("handleProjectDashboard", () => {
  it("create-worktree forwards to createWorktreeForProject", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleProjectDashboard(
      {
        component: { id: "x", type: "project-dashboard" },
        eventType: "create-worktree",
        data: { projectId: "p1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.createWorktreeForProject).toHaveBeenCalledWith("p1");
  });

  it("switch-worktree activates the worktree", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleProjectDashboard(
      {
        component: { id: "x", type: "project-dashboard" },
        eventType: "switch-worktree",
        data: { worktreeId: "w-1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.activateWorktree).toHaveBeenCalledWith("w-1");
  });
});

describe("handleTaskLauncher", () => {
  it("start-task calls ctx.startTaskInProject with the full payload", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleTaskLauncher(
      {
        component: { id: "x", type: "task-launcher" },
        eventType: "start-task",
        data: {
          projectId: "p1",
          prompt: "fix the bug",
          newWorktree: true,
          branch: "fix-bug",
          baseBranch: "main",
        },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.startTaskInProject).toHaveBeenCalledWith({
      projectId: "p1",
      prompt: "fix the bug",
      newWorktree: true,
      branch: "fix-bug",
      baseBranch: "main",
      worktreeId: undefined,
    });
  });

  it("start-task forwards worktreeId for existing-worktree submits", async () => {
    const { ctx } = buildRouteFixture();
    await handleTaskLauncher(
      {
        component: { id: "x", type: "task-launcher" },
        eventType: "start-task",
        data: {
          projectId: "p1",
          prompt: "investigate",
          newWorktree: false,
          worktreeId: "wt-7",
        },
      },
      ctx,
    );
    expect(ctx.startTaskInProject).toHaveBeenCalledWith({
      projectId: "p1",
      prompt: "investigate",
      newWorktree: false,
      branch: undefined,
      baseBranch: undefined,
      worktreeId: "wt-7",
    });
  });

  it("start-task is a no-op when prompt is empty", async () => {
    const { ctx } = buildRouteFixture();
    await handleTaskLauncher(
      {
        component: { id: "x", type: "task-launcher" },
        eventType: "start-task",
        data: { projectId: "p1", prompt: "" },
      },
      ctx,
    );
    expect(ctx.startTaskInProject).not.toHaveBeenCalled();
  });

  it("project chip select forwards to setActiveProjectById", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleTaskLauncher(
      {
        component: { id: "x", type: "task-launcher" },
        eventType: "select-project-card",
        data: { projectId: "p2" },
      },
      ctx,
    );
    expect(mocks.setActiveProjectById).toHaveBeenCalledWith("p2");
  });
});

describe("handleGhStatsStrip", () => {
  it("open-url invokes the opener plugin", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleGhStatsStrip(
      {
        component: { id: "x", type: "gh-stats-strip" },
        eventType: "open-url",
        data: { url: "https://github.com/owner/repo" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
      url: "https://github.com/owner/repo",
    });
  });

  it("open-url is a no-op when url is empty", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleGhStatsStrip(
      {
        component: { id: "x", type: "gh-stats-strip" },
        eventType: "open-url",
        data: {},
      },
      ctx,
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
