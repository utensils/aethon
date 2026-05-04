import { describe, expect, it, vi } from "vitest";
import { handleExtensionComponents } from "./extensionComponents";
import { buildHandlerFixture } from "./testFixtures";

describe("handleExtensionComponents", () => {
  it("hands templates to the registry and acks the mutation", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const setTemplates = vi.spyOn(ctx.registry, "setTemplates");
    handleExtensionComponents(
      {
        type: "extension_components",
        components: { tpl: { type: "container" } },
        mutationId: "m1",
      },
      ctx,
    );
    expect(setTemplates).toHaveBeenCalledWith({ tpl: { type: "container" } });
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });
});
