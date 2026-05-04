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

  it("returns false for other components", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleSettings(
      { component: { id: "search-panel" }, eventType: "close" },
      ctx,
    );
    expect(handled).toBe(false);
  });
});
