import { describe, expect, it } from "vitest";

import { handleMobileNav } from "./mobileNav";
import { buildRouteFixture } from "./testFixtures";

describe("handleMobileNav", () => {
  it("switches screens by setting exactly one visibility flag", async () => {
    const { ctx, applySetState } = buildRouteFixture();
    const handled = await handleMobileNav(
      { component: { id: "nav", type: "mobile-nav" }, eventType: "mobile-nav", data: { screen: "sessions" } },
      ctx,
    );
    expect(handled).toBe(true);
    const state = applySetState({});
    expect(state.mobileNav).toEqual({
      active: "sessions",
      isProjects: false,
      isSessions: true,
      isChat: false,
      isTerminal: false,
      isFiles: false,
      isGit: false,
      isSettings: false,
    });
  });

  it("opens the settings overlay for the settings screen and closes it otherwise", async () => {
    const opened = buildRouteFixture();
    await handleMobileNav(
      { component: { id: "nav", type: "mobile-nav" }, eventType: "mobile-nav", data: { screen: "settings" } },
      opened.ctx,
    );
    expect((opened.applySetState({}).settings as { open?: boolean }).open).toBe(true);

    const closed = buildRouteFixture();
    await handleMobileNav(
      { component: { id: "nav", type: "mobile-nav" }, eventType: "mobile-nav", data: { screen: "chat" } },
      closed.ctx,
    );
    expect((closed.applySetState({}).settings as { open?: boolean }).open).toBe(false);
  });

  it("select-tab activates the tab and jumps to chat", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture();
    const handled = await handleMobileNav(
      { component: { id: "sessions", type: "mobile-sessions" }, eventType: "select-tab", data: { tabId: "t7" } },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.activateTabAnywhere).toHaveBeenCalledWith("t7");
    expect((applySetState({}).mobileNav as { isChat?: boolean }).isChat).toBe(true);
  });

  it("new-session opens a tab and jumps to chat", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture();
    await handleMobileNav(
      { component: { id: "sessions", type: "mobile-sessions" }, eventType: "new-session" },
      ctx,
    );
    expect(mocks.newTab).toHaveBeenCalledTimes(1);
    expect((applySetState({}).mobileNav as { active?: string }).active).toBe("chat");
  });

  it("restore-session reopens the session by id and jumps to chat", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture();
    const handled = await handleMobileNav(
      {
        component: { id: "sessions", type: "mobile-sessions" },
        eventType: "restore-session",
        data: { sessionId: "s42", cwd: "/repo", label: "My session" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.newTab).toHaveBeenCalledWith(
      "s42",
      "My session",
      expect.objectContaining({ restoredSession: true }),
    );
    expect((applySetState({}).mobileNav as { isChat?: boolean }).isChat).toBe(true);
  });

  it("routes mobile project selection through the project selector", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { project: null, activeWorkspaceId: "wt-old" },
    });

    const handled = await handleMobileNav(
      {
        component: { id: "projects", type: "mobile-projects" },
        eventType: "select",
        data: { sectionId: "projects", itemId: "p1" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.activateWorkspace).toHaveBeenCalledWith(null);
    expect(mocks.setActiveProjectById).toHaveBeenCalledWith("p1");
  });

  it("starts a project session from mobile projects and jumps to chat", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture();

    await handleMobileNav(
      {
        component: { id: "projects", type: "mobile-projects" },
        eventType: "start-session",
        data: { projectId: "p1", path: "/repo" },
      },
      ctx,
    );

    expect(mocks.setActiveProjectById).toHaveBeenCalledWith("p1");
    expect(mocks.newTab).toHaveBeenCalledWith(
      undefined,
      undefined,
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect((applySetState({}).mobileNav as { active?: string }).active).toBe("chat");
  });

  it("rejects unknown screen values instead of blanking every flag", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: { mobileNav: { active: "chat", isChat: true } },
    });
    await handleMobileNav(
      {
        component: { id: "nav", type: "mobile-nav" },
        eventType: "mobile-nav",
        data: { screen: "not-a-screen" },
      },
      ctx,
    );
    const state = applySetState({ mobileNav: { active: "chat", isChat: true } });
    expect((state.mobileNav as { active?: string }).active).toBe("chat");
  });

  it("keeps project-bound screens on projects until a project is selected", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: { mobileNav: { active: "projects", isProjects: true } },
    });

    await handleMobileNav(
      {
        component: { id: "nav", type: "mobile-nav" },
        eventType: "mobile-nav",
        data: { screen: "files" },
      },
      ctx,
    );

    const state = applySetState({});
    expect((state.mobileNav as { active?: string }).active).toBe("projects");
    expect((state.mobileNav as { isProjects?: boolean }).isProjects).toBe(true);
    expect((state.mobileNav as { isFiles?: boolean }).isFiles).toBe(false);
  });

  it("allows project-bound screens once a project is selected", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: { activeProjectId: "p1" },
    });

    await handleMobileNav(
      {
        component: { id: "nav", type: "mobile-nav" },
        eventType: "mobile-nav",
        data: { screen: "files" },
      },
      ctx,
    );

    const state = applySetState({});
    expect((state.mobileNav as { active?: string }).active).toBe("files");
    expect((state.mobileNav as { isFiles?: boolean }).isFiles).toBe(true);
  });

  it("open-file opens the viewer with the tapped root+path", async () => {
    const { ctx, applySetState } = buildRouteFixture();
    const handled = await handleMobileNav(
      {
        component: { id: "files", type: "mobile-file-list" },
        eventType: "open-file",
        data: { root: "/repo", path: "src/main.ts" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(applySetState({}).mobileFileViewer).toEqual({
      open: true,
      root: "/repo",
      path: "src/main.ts",
    });
  });

  it("viewer close clears the open flag", async () => {
    const { ctx, applySetState } = buildRouteFixture();
    await handleMobileNav(
      { component: { id: "viewer", type: "mobile-file-viewer" }, eventType: "close" },
      ctx,
    );
    expect((applySetState({}).mobileFileViewer as { open?: boolean }).open).toBe(false);
  });

  it("ignores unrelated component types", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleMobileNav(
      { component: { id: "tabs", type: "tab-strip" }, eventType: "select", data: { tabId: "x" } },
      ctx,
    );
    expect(handled).toBe(false);
  });
});
