import { describe, expect, it } from "vitest";
import {
  handleSidebarResize,
  handleSidebarResizeEnd,
  handleSidebarRemoveProject,
  handleSidebarDeleteSession,
  handleSidebarRenameSession,
  handleSidebarToggleExtension,
  handleSectionedSelect,
} from "./sidebar";
import { buildRouteFixture } from "./testFixtures";

describe("handleSidebarResize", () => {
  it("rewrites just the leading column token", async () => {
    const { ctx, applySetState } = buildRouteFixture();
    const handled = await handleSidebarResize(
      {
        component: { id: "sidebar" },
        eventType: "resize",
        data: { width: 280 },
      },
      ctx,
    );
    expect(handled).toBe(true);
    const next = applySetState({
      layout: { columns: "220px minmax(0,1fr) 320px" },
    });
    expect((next.layout as { columns: string }).columns).toBe(
      "280px minmax(0,1fr) 320px",
    );
  });
});

describe("handleSidebarResizeEnd", () => {
  it("persists the current sidebar width", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { layout: { columns: "240px minmax(0,1fr)" } },
    });
    await handleSidebarResizeEnd(
      { component: { id: "sidebar" }, eventType: "resize-end" },
      ctx,
    );
    expect(mocks.writeState).toHaveBeenCalledWith("sidebar_width", "240");
  });
});

describe("handleSidebarRemoveProject", () => {
  it("delegates to removeProjectById", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSidebarRemoveProject(
      {
        component: { id: "sidebar" },
        eventType: "remove-project",
        data: { projectId: "proj-1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.removeProjectById).toHaveBeenCalledWith("proj-1");
  });
});

describe("handleSidebarDeleteSession", () => {
  it("prompts then deletes when allowed", async () => {
    const { ctx, mocks } = buildRouteFixture({
      promptDeleteAllow: true,
      state: { tabs: [{ id: "sess-1", kind: "agent" }] },
    });
    await handleSidebarDeleteSession(
      {
        component: { id: "sidebar" },
        eventType: "delete-session",
        data: { sessionId: "sess-1", label: "Chat 1" },
      },
      ctx,
    );
    // Resolve the prompt promise + the delete_session invoke.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.invoke).toHaveBeenCalledWith("delete_session", {
      tabId: "sess-1",
    });
  });

  it("returns true and does nothing on empty input", async () => {
    const { ctx, mocks } = buildRouteFixture({ promptDeleteAllow: true });
    const handled = await handleSidebarDeleteSession(
      {
        component: { id: "sidebar" },
        eventType: "delete-session",
        data: {},
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.promptDeleteSessionConfirmation).not.toHaveBeenCalled();
  });
});

describe("handleSidebarRenameSession", () => {
  it("forwards a set_session_label command to the bridge", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSidebarRenameSession(
      {
        component: { id: "sidebar" },
        eventType: "rename-session",
        data: { sessionId: "tab-7", label: "Refactor pass" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "set_session_label",
        tabId: "tab-7",
        label: "Refactor pass",
      }),
    });
  });

  it("optimistically updates an open tab's label so the rename is instant", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        tabs: [
          { id: "tab-7", kind: "agent", label: "Tab 1" },
          { id: "tab-9", kind: "agent", label: "Tab 2" },
        ],
      },
    });
    await handleSidebarRenameSession(
      {
        component: { id: "sidebar" },
        eventType: "rename-session",
        data: { sessionId: "tab-7", label: "Refactor pass" },
      },
      ctx,
    );
    const next = applySetState({
      tabs: [
        { id: "tab-7", kind: "agent", label: "Tab 1" },
        { id: "tab-9", kind: "agent", label: "Tab 2" },
      ],
    });
    const tabs = next.tabs as { id: string; label: string }[];
    expect(tabs[0].label).toBe("Refactor pass");
    expect(tabs[1].label).toBe("Tab 2");
  });

  it("empty label restores the auto sequential label for the open tab", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        tabs: [
          { id: "tab-3", kind: "agent", label: "Custom name" },
        ],
      },
    });
    await handleSidebarRenameSession(
      {
        component: { id: "sidebar" },
        eventType: "rename-session",
        data: { sessionId: "tab-3", label: "  " },
      },
      ctx,
    );
    const next = applySetState({
      tabs: [{ id: "tab-3", kind: "agent", label: "Custom name" }],
    });
    expect((next.tabs as { label: string }[])[0].label).toBe("Tab 1");
  });
});

describe("handleSidebarToggleExtension", () => {
  it("forwards a set_extension_disabled command to the bridge", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSidebarToggleExtension(
      {
        component: { id: "sidebar" },
        eventType: "toggle-extension",
        data: { name: "mold:image-gallery", disabled: true },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "set_extension_disabled",
        name: "mold:image-gallery",
        disabled: true,
      }),
    });
  });

  it("ignores non-toggle events for the sidebar", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSidebarToggleExtension(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { name: "x", disabled: true },
      },
      ctx,
    );
    expect(handled).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("handleSectionedSelect", () => {
  it("toggle-terminal hits toggleTerminal", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { itemId: "toggle-terminal" },
      },
      ctx,
    );
    expect(mocks.toggleTerminal).toHaveBeenCalledTimes(1);
  });

  it("models section calls setModel", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleSectionedSelect(
      {
        component: { id: "model-picker" },
        eventType: "select",
        data: { sectionId: "models", itemId: "anthropic/claude-opus-4-7" },
      },
      ctx,
    );
    expect(mocks.setModel).toHaveBeenCalledWith("anthropic/claude-opus-4-7");
  });

  it("themes section calls setTheme", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleSectionedSelect(
      {
        component: { id: "appearance-menu" },
        eventType: "select",
        data: { sectionId: "themes", itemId: "dim" },
      },
      ctx,
    );
    expect(mocks.setTheme).toHaveBeenCalledWith("dim");
  });

  it("history section with tab: prefix activates that tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "history", itemId: "tab:abc123" },
      },
      ctx,
    );
    expect(mocks.setActiveTab).toHaveBeenCalledWith("abc123");
  });

  it("projects open-project triggers the picker", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "projects", itemId: "open-project" },
      },
      ctx,
    );
    expect(mocks.openProjectFromPicker).toHaveBeenCalledTimes(1);
  });

  it("returns false for non-select events", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleSectionedSelect(
      { component: { id: "sidebar" }, eventType: "click" },
      ctx,
    );
    expect(handled).toBe(false);
  });
});
