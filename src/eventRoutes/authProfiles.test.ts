import { describe, expect, it } from "vitest";
import { handleAuthProfiles } from "./authProfiles";
import { buildRouteFixture } from "./testFixtures";

describe("handleAuthProfiles", () => {
  it("closes the auth profiles modal on close events", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        authProfiles: {
          profiles: [{ id: "anthropic-work", label: "Work" }],
          defaultByProvider: { anthropic: "anthropic-work" },
          providers: [],
          activeByTab: { default: "anthropic-work" },
          modal: { open: true },
        },
      },
    });

    const handled = await handleAuthProfiles(
      { component: { id: "auth-profile-panel" }, eventType: "close" },
      ctx,
    );

    expect(handled).toBe(true);
    expect(applySetState().authProfiles).toMatchObject({
      profiles: [{ id: "anthropic-work", label: "Work" }],
      defaultByProvider: { anthropic: "anthropic-work" },
      activeByTab: { default: "anthropic-work" },
      modal: { open: false },
    });
  });

  it("returns false for non-close events", async () => {
    const { ctx, mocks } = buildRouteFixture();

    const handled = await handleAuthProfiles(
      { component: { id: "auth-profile-panel" }, eventType: "submit" },
      ctx,
    );

    expect(handled).toBe(false);
    expect(mocks.setState).not.toHaveBeenCalled();
  });
});
