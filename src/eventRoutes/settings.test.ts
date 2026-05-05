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

  // Wrong-component rejection is no longer this handler's job — the
  // route table dispatches by `type:settings-panel`, so an event for a
  // different type never reaches handleSettings. See index.test.ts for
  // the type-keyed routing contract.
});
