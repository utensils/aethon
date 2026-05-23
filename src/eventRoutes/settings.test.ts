import { describe, expect, it } from "vitest";
import { handleSettings } from "./settings";
import { buildRouteFixture } from "./testFixtures";

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

  it("save commits via saveSettings", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSettings(
      { component: { id: "settings-panel" }, eventType: "save" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
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
        columns: "220px minmax(0,1fr) 360px",
        lastLeftWidth: "220px",
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
