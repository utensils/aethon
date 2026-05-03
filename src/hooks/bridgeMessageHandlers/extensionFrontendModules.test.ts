import { describe, expect, it } from "vitest";
import { handleExtensionFrontendModules } from "./extensionFrontendModules";
import { buildHandlerFixture } from "./testFixtures";

describe("handleExtensionFrontendModules", () => {
  it("hydrates frontend modules and acks", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const modules = [{ name: "ext-a", code: "/* code */" }];
    handleExtensionFrontendModules(
      { type: "extension_frontend_modules", modules, mutationId: "m1" },
      ctx,
    );
    expect(mocks.hydrateFrontendModules).toHaveBeenCalledWith(modules);
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });
});
