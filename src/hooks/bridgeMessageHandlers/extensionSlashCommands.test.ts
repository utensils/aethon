import { describe, expect, it } from "vitest";
import { handleExtensionSlashCommands } from "./extensionSlashCommands";
import { buildHandlerFixture } from "./testFixtures";

describe("handleExtensionSlashCommands", () => {
  it("hydrates slash commands and acks", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const commands = [{ name: "foo", description: "bar" }];
    handleExtensionSlashCommands(
      { type: "extension_slash_commands", commands, mutationId: "m1" },
      ctx,
    );
    expect(mocks.hydrateSlashCommands).toHaveBeenCalledWith(commands);
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });
});
