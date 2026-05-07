import { describe, expect, it } from "vitest";
import { handleTabStrip, handleEmptyState } from "./tabStrip";
import { buildRouteFixture } from "./testFixtures";

describe("handleTabStrip", () => {
  it("select activates the chosen tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleTabStrip(
      {
        component: { id: "header-tabs", type: "tab-strip" },
        eventType: "select",
        data: { tabId: "tab-3" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.setActiveTab).toHaveBeenCalledWith("tab-3");
  });

  it("close removes the chosen tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleTabStrip(
      {
        component: { id: "header-tabs", type: "tab-strip" },
        eventType: "close",
        data: { tabId: "tab-4" },
      },
      ctx,
    );
    expect(mocks.closeTab).toHaveBeenCalledWith("tab-4");
  });

  it("new spawns a fresh tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleTabStrip(
      {
        component: { id: "header-tabs", type: "tab-strip" },
        eventType: "new",
      },
      ctx,
    );
    expect(mocks.newTab).toHaveBeenCalledTimes(1);
  });
});

describe("handleEmptyState", () => {
  it("new-tab spawns a tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleEmptyState(
      { component: { id: "empty-state" }, eventType: "new-tab" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.newTab).toHaveBeenCalledTimes(1);
  });

  it("open-project opens the picker without creating a tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleEmptyState(
      {
        component: { id: "empty-state" },
        eventType: "open-project",
      },
      ctx,
    );
    expect(mocks.openProjectFromPicker).toHaveBeenCalledTimes(1);
    expect(mocks.newTab).not.toHaveBeenCalled();
  });

  it("select-project only switches projects", async () => {
    const { ctx, mocks } = buildRouteFixture({ state: { tabs: [] } });
    await handleEmptyState(
      {
        component: { id: "empty-state" },
        eventType: "select-project",
        data: { projectId: "proj-1" },
      },
      ctx,
    );
    expect(mocks.setActiveProjectById).toHaveBeenCalledWith("proj-1");
    expect(mocks.newTab).not.toHaveBeenCalled();
  });

  it("restore-session reuses the sessionId as the new tabId", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleEmptyState(
      {
        component: { id: "empty-state" },
        eventType: "restore-session",
        data: { sessionId: "sess-9", label: "old chat", cwd: "/repo" },
      },
      ctx,
    );
    expect(mocks.newTab).toHaveBeenCalledWith("sess-9", "old chat", {
      restoredSession: true,
      cwd: "/repo",
    });
  });
});
