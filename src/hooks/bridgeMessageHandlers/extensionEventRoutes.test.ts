import { describe, expect, it } from "vitest";
import { handleExtensionEventRoutes } from "./extensionEventRoutes";
import { buildHandlerFixture } from "./testFixtures";

describe("handleExtensionEventRoutes", () => {
  it("hydrates routes with builtin mode by default", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const routes = [{ componentId: "btn-1", eventType: "click" }];
    handleExtensionEventRoutes(
      { type: "extension_event_routes", routes, mutationId: "m1" },
      ctx,
    );
    expect(mocks.hydrateEventRoutes).toHaveBeenCalledWith(routes, "builtin");
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });

  it("forwards extension mode when set", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleExtensionEventRoutes(
      { type: "extension_event_routes", routes: [], mode: "extension" },
      ctx,
    );
    expect(mocks.hydrateEventRoutes).toHaveBeenCalledWith([], "extension");
  });
});
