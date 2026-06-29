import { describe, expect, it } from "vitest";
import {
  handleGhStatsStrip,
  handleProjectDashboard,
  handleProjectsDashboard,
  handleTaskLauncher,
} from "./dashboard";
import { buildRouteFixture } from "./testFixtures";
import { makeEmptyTab } from "../types/tab";

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
      state: { landing: { kind: "workspace", workspaceId: "w-1" } },
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
    expect(ctx.activateWorkspace).toHaveBeenCalledWith(null);
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

  it("restore-session navigates to the matching workspace before opening", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        activeProjectId: "p1",
        projects: [{ id: "p1", path: "/repo/app" }],
        sidebar: {
          projects: [
            {
              id: "p1",
              workspaces: [
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
    expect(mocks.activateWorkspace).toHaveBeenCalledWith("wt-1");
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
  it("create-workspace forwards to createWorkspaceForProject", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleProjectDashboard(
      {
        component: { id: "x", type: "project-dashboard" },
        eventType: "create-workspace",
        data: { projectId: "p1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.createWorkspaceForProject).toHaveBeenCalledWith("p1");
  });

  it("switch-workspace builds the workspace landing", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        sidebar: {
          projects: [
            {
              id: "p1",
              label: "aethon",
              workspaces: [
                {
                  id: "w-1",
                  label: "fix/session",
                  branch: "fix/session",
                  path: "/repo/aethon-fix-session",
                  isMain: false,
                },
              ],
            },
          ],
        },
      },
    });
    const handled = await handleProjectDashboard(
      {
        component: { id: "x", type: "project-dashboard" },
        eventType: "switch-workspace",
        data: { workspaceId: "w-1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.activateWorkspace).toHaveBeenCalledWith("w-1");
    expect(applySetState().landing).toMatchObject({
      kind: "workspace",
      projectId: "p1",
      workspaceId: "w-1",
      path: "/repo/aethon-fix-session",
    });
  });

  it("switch-workspace shows landing when the destination scope is empty", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        activeWorkspaceId: "w-current",
        activeTabId: "tab-current",
        tabs: [
          {
            id: "tab-current",
            kind: "agent",
            projectId: "p1",
            cwd: "/repo/aethon-current",
            messages: [{ id: "m1", role: "user", text: "current" }],
            draft: "",
            waiting: false,
            queueCount: 0,
            canvas: null,
            terminalBuffer: "",
          },
        ],
        sidebar: {
          projects: [
            {
              id: "p1",
              label: "aethon",
              workspaces: [
                {
                  id: "w-next",
                  label: "fix/session",
                  branch: "fix/session",
                  path: "/repo/aethon-fix-session",
                  isMain: false,
                },
              ],
            },
          ],
        },
      },
    });
    mocks.activateWorkspace.mockImplementation(() => {
      ctx.stateRef.current = {
        ...ctx.stateRef.current,
        activeWorkspaceId: "w-next",
        activeTabId: undefined,
        tabs: [],
      };
    });

    const handled = await handleProjectDashboard(
      {
        component: { id: "x", type: "project-dashboard" },
        eventType: "switch-workspace",
        data: { workspaceId: "w-next" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(ctx.activateWorkspace).toHaveBeenCalledWith("w-next");
    expect(applySetState().landing).toMatchObject({
      kind: "workspace",
      projectId: "p1",
      workspaceId: "w-next",
      path: "/repo/aethon-fix-session",
    });
  });

  it("forwards dashboard workspace removal to the shared remove route", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleProjectDashboard(
      {
        component: { id: "project-dashboard", type: "project-dashboard" },
        eventType: "remove-workspace",
        data: { workspaceId: "wt-1", confirmed: true },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.removeWorkspaceById).toHaveBeenCalledWith("wt-1", {
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
          newWorkspace: true,
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
        newWorkspace: true,
        branch: "fix/issue-927-crash-on-boot",
      }),
    );
  });

  it("forwards issue-section existing-session clicks emitted through the project dashboard", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleProjectDashboard(
      {
        component: { id: "project-dashboard", type: "project-dashboard" },
        eventType: "open-issue-session",
        data: { tabId: "issue-tab", issueNumber: 927 },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.activateTabAnywhere).toHaveBeenCalledWith("issue-tab");
  });

  it("forwards issue-section refresh cleanup emitted through the project dashboard", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleProjectDashboard(
      {
        component: { id: "project-dashboard", type: "project-dashboard" },
        eventType: "issues-refreshed",
        data: {
          projectId: "p1",
          openIssueNumbers: [84, "86", 84.5, "87.5", 0, -1, "bad"],
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.clearClosedIssueLinksForProject).toHaveBeenCalledWith(
      "p1",
      new Set([84, 86]),
    );
  });

  it("opens an existing issue session instead of launching a duplicate", async () => {
    const linked = {
      ...makeEmptyTab("issue-tab", "Issue 927", "p1"),
      sourceIssue: {
        kind: "github-issue" as const,
        projectId: "p1",
        number: 927,
        url: "https://github.com/utensils/aethon/issues/927",
        title: "Crash on boot",
        branch: "fix/issue-927-crash-on-boot",
        workspaceId: "wt-927",
        workspacePath: "/repo/aethon-fix-927",
        createdAt: 1,
      },
    };
    const { ctx, mocks } = buildRouteFixture({ state: { tabs: [linked] } });
    const handled = await handleProjectDashboard(
      {
        component: { id: "project-dashboard", type: "project-dashboard" },
        eventType: "start-task",
        data: {
          projectId: "p1",
          prompt: "Please work on issue #927",
          newWorkspace: true,
          branch: "fix/issue-927-crash-on-boot",
          source: "github-issue",
          issueNumber: 927,
          issueUrl: "https://github.com/utensils/aethon/issues/927",
          issueTitle: "Crash on boot",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.activateTabAnywhere).toHaveBeenCalledWith("issue-tab");
    expect(ctx.startTaskInProject).not.toHaveBeenCalled();
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
  it("projects-dashboard start-task launches a host tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleProjectsDashboard(
      {
        component: { id: "projects-dashboard", type: "projects-dashboard" },
        eventType: "start-task",
        data: {
          target: "host",
          prompt: "check the host",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.newTab).toHaveBeenCalledOnce();
    const tabId = mocks.newTab.mock.calls[0]?.[0];
    expect(typeof tabId).toBe("string");
    expect(mocks.sendChat).toHaveBeenCalledWith("check the host", {
      tabId,
      attachments: undefined,
    });
    expect(ctx.startTaskInProject).not.toHaveBeenCalled();
  });

  it("start-task calls ctx.startTaskInProject with the full payload", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleTaskLauncher(
      {
        component: { id: "x", type: "task-launcher" },
        eventType: "start-task",
        data: {
          projectId: "p1",
          prompt: "fix the bug",
          newWorkspace: true,
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
      newWorkspace: true,
      branch: "fix-bug",
      baseBranch: "main",
      workspaceId: undefined,
    });
  });

  it("start-task forwards GitHub issue origin metadata", async () => {
    const { ctx } = buildRouteFixture();
    await handleTaskLauncher(
      {
        component: { id: "x", type: "task-launcher" },
        eventType: "start-task",
        data: {
          projectId: "p1",
          prompt: "fix issue",
          newWorkspace: true,
          branch: "fix/issue-85-cannot-rename-session-tab",
          source: "github-issue",
          issueNumber: 85,
          issueUrl: "https://github.com/utensils/aethon/issues/85",
          issueTitle: "Cannot rename session tab while agent is running",
        },
      },
      ctx,
    );

    expect(ctx.startTaskInProject).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIssue: expect.objectContaining({
          kind: "github-issue",
          projectId: "p1",
          number: 85,
          url: "https://github.com/utensils/aethon/issues/85",
          title: "Cannot rename session tab while agent is running",
          branch: "fix/issue-85-cannot-rename-session-tab",
        }),
      }),
    );
  });

  it("issues-refreshed clears issue links that are no longer open", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleTaskLauncher(
      {
        component: { id: "x", type: "issues-section" },
        eventType: "issues-refreshed",
        data: {
          projectId: "p1",
          openIssueNumbers: [84, "86", 84.5, "87.5", 0, -1, "bad"],
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.clearClosedIssueLinksForProject).toHaveBeenCalledWith(
      "p1",
      new Set([84, 86]),
    );
  });

  it("start-task forwards workspaceId for existing-workspace submits", async () => {
    const { ctx } = buildRouteFixture();
    await handleTaskLauncher(
      {
        component: { id: "x", type: "task-launcher" },
        eventType: "start-task",
        data: {
          projectId: "p1",
          prompt: "investigate",
          newWorkspace: false,
          workspaceId: "wt-7",
        },
      },
      ctx,
    );
    expect(ctx.startTaskInProject).toHaveBeenCalledWith({
      projectId: "p1",
      prompt: "investigate",
      newWorkspace: false,
      branch: undefined,
      baseBranch: undefined,
      workspaceId: "wt-7",
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
    expect(ctx.activateWorkspace).toHaveBeenCalledWith(null);
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
