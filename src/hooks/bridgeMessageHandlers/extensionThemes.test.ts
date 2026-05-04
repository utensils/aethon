import { describe, expect, it } from "vitest";
import { handleExtensionThemes } from "./extensionThemes";
import { buildHandlerFixture } from "./testFixtures";

describe("handleExtensionThemes", () => {
  it("hydrates themes and acks", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const themes = [{ id: "neon", label: "Neon", vars: {} }];
    handleExtensionThemes(
      { type: "extension_themes", themes, mutationId: "m1" },
      ctx,
    );
    expect(mocks.hydrateThemes).toHaveBeenCalledWith(themes);
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });
});
