import { describe, expect, it } from "vitest";
import { handleExtensionKeybindings } from "./extensionKeybindings";
import { buildHandlerFixture } from "./testFixtures";

describe("handleExtensionKeybindings", () => {
  it("hydrates keybindings and acks", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const bindings = [{ combo: "Cmd+J", action: "do-thing" }];
    handleExtensionKeybindings(
      { type: "extension_keybindings", bindings, mutationId: "m1" },
      ctx,
    );
    expect(mocks.hydrateKeybindings).toHaveBeenCalledWith(bindings);
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });
});
