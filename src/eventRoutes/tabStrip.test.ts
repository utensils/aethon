import { describe, expect, it } from "vitest";
import { handleTabStrip, handleEmptyState } from "./tabStrip";
import { OVERVIEW_TAB_ID } from "../types/tab";
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

  it("select on the overview sentinel routes to activateOverview, not setActiveTab", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: { activeTabId: "tab-7" },
    });
    const handled = await handleTabStrip(
      {
        component: { id: "header-tabs", type: "tab-strip" },
        eventType: "select",
        data: { tabId: OVERVIEW_TAB_ID },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.setActiveTab).not.toHaveBeenCalled();
    const next = applySetState({ activeTabId: "tab-7" });
    expect(next.activeTabId).toBe(OVERVIEW_TAB_ID);
  });

  it("selecting overview while already on overview is a no-op write", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: { activeTabId: OVERVIEW_TAB_ID },
    });
    await handleTabStrip(
      {
        component: { id: "header-tabs", type: "tab-strip" },
        eventType: "select",
        data: { tabId: OVERVIEW_TAB_ID },
      },
      ctx,
    );
    expect(mocks.setActiveTab).not.toHaveBeenCalled();
    // The reducer short-circuits, so unrelated state survives the
    // pass-through and activeTabId is unchanged.
    const next = applySetState({
      activeTabId: OVERVIEW_TAB_ID,
      foo: "bar",
    });
    expect(next).toEqual({ activeTabId: OVERVIEW_TAB_ID, foo: "bar" });
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

  it("close-others closes every non-shell tab except the chosen one", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        tabs: [
          { id: "ed-1", kind: "editor" },
          { id: "ed-2", kind: "editor" },
          { id: "ag-1", kind: "agent" },
          { id: "sh-1", kind: "shell" },
        ],
      },
    });
    await handleTabStrip(
      {
        component: { id: "header-tabs", type: "tab-strip" },
        eventType: "close-others",
        data: { tabId: "ed-1" },
      },
      ctx,
    );
    expect(mocks.closeTab).toHaveBeenCalledWith("ed-2");
    expect(mocks.closeTab).toHaveBeenCalledWith("ag-1");
    expect(mocks.closeTab).not.toHaveBeenCalledWith("ed-1");
    expect(mocks.closeTab).not.toHaveBeenCalledWith("sh-1");
  });

  it("close-others from overview closes every non-shell tab", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        tabs: [
          { id: "ed-1", kind: "editor" },
          { id: "ag-1", kind: "agent" },
          { id: "sh-1", kind: "shell" },
        ],
      },
    });
    await handleTabStrip(
      {
        component: { id: "header-tabs", type: "tab-strip" },
        eventType: "close-others",
        data: { tabId: OVERVIEW_TAB_ID },
      },
      ctx,
    );
    expect(mocks.closeTab).toHaveBeenCalledWith("ed-1");
    expect(mocks.closeTab).toHaveBeenCalledWith("ag-1");
    expect(mocks.closeTab).not.toHaveBeenCalledWith("sh-1");
  });

  it("close-all closes every non-shell tab", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        tabs: [
          { id: "ed-1", kind: "editor" },
          { id: "ag-1", kind: "agent" },
          { id: "sh-1", kind: "shell" },
        ],
      },
    });
    await handleTabStrip(
      {
        component: { id: "header-tabs", type: "tab-strip" },
        eventType: "close-all",
      },
      ctx,
    );
    expect(mocks.closeTab).toHaveBeenCalledWith("ed-1");
    expect(mocks.closeTab).toHaveBeenCalledWith("ag-1");
    expect(mocks.closeTab).not.toHaveBeenCalledWith("sh-1");
  });

  it("rename updates the label and persists it through the bridge", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        tabs: [
          { id: "tab-4", kind: "agent", label: "Tab 1" },
          { id: "tab-5", kind: "agent", label: "Tab 2" },
        ],
      },
    });
    const handled = await handleTabStrip(
      {
        component: { id: "header-tabs", type: "tab-strip" },
        eventType: "rename",
        data: { tabId: "tab-4", label: "Planning" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "set_session_label",
        tabId: "tab-4",
        label: "Planning",
      }),
    });
    const next = applySetState({
      tabs: [
        { id: "tab-4", kind: "agent", label: "Tab 1" },
        { id: "tab-5", kind: "agent", label: "Tab 2" },
      ],
    });
    expect((next.tabs as { id: string; label: string }[])[0].label).toBe(
      "Planning",
    );
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
