import { describe, expect, it } from "vitest";
import { matchesExtensionRoute } from "./extensions";
import { buildRouteFixture } from "./testFixtures";

describe("matchesExtensionRoute", () => {
  it("returns true when routing mode is 'extension'", () => {
    const { ctx } = buildRouteFixture({ extensionRoutingMode: "extension" });
    expect(
      matchesExtensionRoute(
        { component: { id: "anything" }, eventType: "click" },
        ctx,
      ),
    ).toBe(true);
  });

  it("returns false when no routes are registered", () => {
    const { ctx } = buildRouteFixture();
    expect(
      matchesExtensionRoute(
        { component: { id: "settings-panel" }, eventType: "close" },
        ctx,
      ),
    ).toBe(false);
  });

  it("matches by componentId", () => {
    const { ctx } = buildRouteFixture({
      extensionRoutes: [{ componentId: "settings-panel" }],
    });
    expect(
      matchesExtensionRoute(
        { component: { id: "settings-panel" }, eventType: "close" },
        ctx,
      ),
    ).toBe(true);
  });

  it("matches by eventType (componentId wildcard)", () => {
    const { ctx } = buildRouteFixture({
      extensionRoutes: [{ eventType: "submit" }],
    });
    expect(
      matchesExtensionRoute(
        { component: { id: "anything" }, eventType: "submit" },
        ctx,
      ),
    ).toBe(true);
  });

  it("does not match when only componentId differs", () => {
    const { ctx } = buildRouteFixture({
      extensionRoutes: [{ componentId: "other-panel", eventType: "submit" }],
    });
    expect(
      matchesExtensionRoute(
        { component: { id: "settings-panel" }, eventType: "submit" },
        ctx,
      ),
    ).toBe(false);
  });
});
