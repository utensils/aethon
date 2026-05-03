import { describe, expect, it } from "vitest";
import { handleExtensionLayouts } from "./extensionLayouts";
import { buildHandlerFixture } from "./testFixtures";

describe("handleExtensionLayouts", () => {
  it("hydrates extension-supplied layouts and acks", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const layouts = [
      { id: "alt", name: "Alt", payload: { components: [] } },
    ];
    handleExtensionLayouts(
      { type: "extension_layouts", layouts, mutationId: "m1" },
      ctx,
    );
    expect(mocks.hydrateExtensionLayouts).toHaveBeenCalledWith(layouts);
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });
});
