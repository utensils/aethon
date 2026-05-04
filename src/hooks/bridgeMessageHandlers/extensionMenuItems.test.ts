import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleExtensionMenuItems } from "./extensionMenuItems";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("handleExtensionMenuItems", () => {
  let harness: ReturnType<typeof installTauriMocks>;
  beforeEach(() => {
    harness = installTauriMocks();
  });
  afterEach(() => {
    clearTauriMocks();
  });

  it("forwards items to set_extension_menu_items and acks on success", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(undefined);
    const items = [
      { id: "i1", label: "Foo", action: "foo", location: "app" as const },
    ];
    handleExtensionMenuItems(
      { type: "extension_menu_items", items, mutationId: "m1" },
      ctx,
    );
    // Wait for the invoke promise to resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("set_extension_menu_items", {
      items,
    });
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });
});
