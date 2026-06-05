import { describe, expect, it } from "vitest";
import { handleSettings } from "./settings";
import { buildRouteFixture } from "./testFixtures";
import { DEFAULT_AETHON_SYSTEM_PROMPT } from "../systemPromptBaseline";

describe("handleSettings", () => {
  it("close calls closeSettings", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSettings(
      { component: { id: "settings-panel" }, eventType: "close" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.closeSettings).toHaveBeenCalledTimes(1);
  });

  it("update applies a partial config patch", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSettings(
      {
        component: { id: "settings-panel" },
        eventType: "update",
        data: { patch: { theme: "dark" } },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.applySettingsPatch).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("save flushes any pending autosave for legacy settings components", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSettings(
      { component: { id: "settings-panel" }, eventType: "save" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("forwards extension toggles from the settings panel", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSettings(
      {
        component: { id: "settings-panel" },
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

  it("opens config.toml in a host-level editor tab rooted at the Aethon dir", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { activeProjectId: "project-1" },
    });
    mocks.invoke
      .mockResolvedValueOnce("/Users/test/.aethon")
      .mockResolvedValueOnce("");
    const handled = await handleSettings(
      {
        component: { id: "settings-panel" },
        eventType: "open-config-file",
      },
      ctx,
    );
    expect(handled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "aethon_home_dir");
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "read_state", {
      name: "config.toml",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "write_state", {
      name: "config.toml",
      content: "",
    });
    expect(mocks.clearActiveProject).toHaveBeenCalledTimes(1);
    expect(mocks.newEditorTab).toHaveBeenCalledWith(
      "/Users/test/.aethon/config.toml",
      { rootPath: "/Users/test/.aethon" },
    );
    expect(
      mocks.clearActiveProject.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.newEditorTab.mock.invocationCallOrder[0]);
    expect(mocks.closeSettings).toHaveBeenCalledTimes(1);
  });

  it("surfaces a notification when config.toml cannot be opened", async () => {
    const { ctx, mocks } = buildRouteFixture();
    mocks.invoke.mockRejectedValueOnce(new Error("boom"));
    const handled = await handleSettings(
      {
        component: { id: "settings-panel" },
        eventType: "open-config-file",
      },
      ctx,
    );
    expect(handled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.newEditorTab).not.toHaveBeenCalled();
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Open config.toml failed",
        kind: "error",
      }),
    );
  });

  it("opens system-prompt.md in an editor tab rooted at the Aethon dir", async () => {
    const { ctx, mocks } = buildRouteFixture();
    mocks.invoke
      .mockResolvedValueOnce("/Users/test/.aethon")
      .mockResolvedValueOnce("");
    const handled = await handleSettings(
      {
        component: { id: "settings-panel" },
        eventType: "open-system-prompt",
      },
      ctx,
    );
    expect(handled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "aethon_home_dir");
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "read_state", {
      name: "system-prompt.md",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "write_state", {
      name: "system-prompt.md",
      content: expect.stringContaining("# About Aethon"),
    });
    expect(mocks.invoke.mock.calls[2]?.[1]).toEqual({
      name: "system-prompt.md",
      content: expect.stringContaining(DEFAULT_AETHON_SYSTEM_PROMPT.slice(0, 80)),
    });
    expect(mocks.newEditorTab).toHaveBeenCalledWith(
      "/Users/test/.aethon/system-prompt.md",
      { rootPath: "/Users/test/.aethon" },
    );
    expect(mocks.closeSettings).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite an existing system prompt while opening it", async () => {
    const { ctx, mocks } = buildRouteFixture();
    mocks.invoke
      .mockResolvedValueOnce("/Users/test/.aethon")
      .mockResolvedValueOnce("custom prompt");
    await handleSettings(
      {
        component: { id: "settings-panel" },
        eventType: "open-system-prompt",
      },
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.invoke).not.toHaveBeenCalledWith("write_state", {
      name: "system-prompt.md",
      content: "",
    });
    expect(mocks.newEditorTab).toHaveBeenCalledWith(
      "/Users/test/.aethon/system-prompt.md",
      { rootPath: "/Users/test/.aethon" },
    );
  });

  it("reset-layout-prefs restores layout defaults and clears persisted prefs", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        layout: {
          sidebarVisible: false,
          filesSidebarVisible: false,
          columns: "310px minmax(0,1fr)",
          lastLeftWidth: "310px",
          lastRightWidth: "520px",
        },
        terminalPanel: { activeSubId: "agent-bash", height: 420 },
      },
    });
    const handled = await handleSettings(
      {
        component: { id: "settings-panel" },
        eventType: "reset-layout-prefs",
      },
      ctx,
    );
    expect(handled).toBe(true);
    const next = applySetState();
    expect(next.layout).toEqual(
      expect.objectContaining({
        sidebarVisible: true,
        filesSidebarVisible: true,
        columns: "320px minmax(0,1fr) 360px",
        lastLeftWidth: "320px",
        lastRightWidth: "360px",
      }),
    );
    expect(next.terminalPanel).toEqual({ activeSubId: "agent-bash" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.writeState).toHaveBeenCalledWith("layout_prefs", "");
    expect(mocks.writeState).toHaveBeenCalledWith("file-tree-prefs.json", "");
  });

  // Wrong-component rejection is no longer this handler's job — the
  // route table dispatches by `type:settings-panel`, so an event for a
  // different type never reaches handleSettings. See index.test.ts for
  // the type-keyed routing contract.
});
