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
      {
        component: { id: "projects-dashboard", type: "projects-dashboard" },
        eventType: "new-tab",
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.newTab).toHaveBeenCalledTimes(1);
  });

  it("open-project calls openProjectFromPicker", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleProjectsDashboard(
      {
        component: { id: "x", type: "projects-dashboard" },
        eventType: "open-project",
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.openProjectFromPicker).toHaveBeenCalledTimes(1);
  });

  it("select-project-card activates the project", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: { landing: { kind: "worktree", worktreeId: "w-1" } },
    });
    const handled = await handleProjectsDashboard(
      {
        component: { id: "x", type: "projects-dashboard" },
        eventType: "select-project-card",
        data: { projectId: "p1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.activateWorktree).toHaveBeenCalledWith(null);
    expect(mocks.setActiveProjectById).toHaveBeenCalledWith("p1");
    expect(applySetState().landing).toBeNull();
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

  it("restore-session navigates to the matching worktree before opening", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        activeProjectId: "p1",
        projects: [{ id: "p1", path: "/repo/app" }],
        sidebar: {
          projects: [
            {
              id: "p1",
              worktrees: [
                { id: "wt-1", path: "/repo/app-fix-session-restore" },
              ],
            },
          ],
        },
      },
    });
    const handled = await handleProjectsDashboard(
      {
        component: { id: "x", type: "projects-dashboard" },
        eventType: "restore-session",
        data: {
          sessionId: "tab-42",
          label: "Earlier",
          cwd: "/repo/app-fix-session-restore",
        },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.setActiveProjectById).not.toHaveBeenCalled();
    expect(mocks.activateWorktree).toHaveBeenCalledWith("wt-1");
    expect(mocks.newTab).toHaveBeenCalledWith("tab-42", "Earlier", {
      restoredSession: true,
      cwd: "/repo/app-fix-session-restore",
    });
  });

  it("delete-session can skip the sticky prompt after inline confirmation", async () => {
    const { ctx, mocks } = buildRouteFixture({ promptDeleteAllow: true });
    const handled = await handleProjectsDashboard(
      {
        component: { id: "x", type: "projects-dashboard" },
        eventType: "delete-session",
        data: { sessionId: "tab-42", label: "Earlier", confirmed: true },
      },
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handled).toBe(true);
    expect(mocks.promptDeleteSessionConfirmation).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("delete_session", {
      tabId: "tab-42",
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

  it("forwards dashboard worktree removal to the shared remove route", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleProjectDashboard(
      {
        component: { id: "project-dashboard", type: "project-dashboard" },
        eventType: "remove-worktree",
        data: { worktreeId: "wt-1", confirmed: true },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.removeWorktreeById).toHaveBeenCalledWith("wt-1", {
      confirmed: true,
    });
  });

  it("forwards issue-section start-task events emitted through the project dashboard", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleProjectDashboard(
      {
        component: { id: "project-dashboard", type: "project-dashboard" },
        eventType: "start-task",
        data: {
          projectId: "p1",
          prompt: "Please work on issue #927",
          newWorktree: true,
          branch: "fix/issue-927-crash-on-boot",
          source: "github-issue",
        },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.startTaskInProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        prompt: "Please work on issue #927",
        newWorktree: true,
        branch: "fix/issue-927-crash-on-boot",
      }),
    );
  });

  it("forwards task-launcher paste failures emitted through the project dashboard", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleProjectDashboard(
      {
        component: { id: "project-dashboard", type: "project-dashboard" },
        eventType: "paste-image-failed",
        data: { message: "payload exceeds 32 MiB" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Image paste failed",
        message: "payload exceeds 32 MiB",
        kind: "error",
      }),
    );
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
    expect(ctx.activateWorktree).toHaveBeenCalledWith(null);
    expect(mocks.setActiveProjectById).toHaveBeenCalledWith("p2");
  });

  it("paste-image-failed notifies the user", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleTaskLauncher(
      {
        component: { id: "x", type: "task-launcher" },
        eventType: "paste-image-failed",
        data: { message: "payload exceeds 32 MiB" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.pushNotification).toHaveBeenCalledWith({
      id: "ae-task-paste-image-failed",
      title: "Image paste failed",
      message: "payload exceeds 32 MiB",
      kind: "error",
      durationMs: 3000,
    });
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
