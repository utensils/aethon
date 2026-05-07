import { describe, expect, it } from "vitest";
import {
  buildHydratedSlashCommands,
} from "./useExtensionsHydration";
import {
  buildBuiltinSlashCommands,
  type SlashCommand,
} from "../slashCommands";

describe("buildHydratedSlashCommands", () => {
  it("keeps Aethon built-ins ahead of colliding pi passthrough commands", () => {
    const commands = buildHydratedSlashCommands(
      buildBuiltinSlashCommands(),
      [],
      [
        {
          name: "context",
          description: "pi context passthrough",
        },
        {
          name: "pi-only",
          description: "pi-only command",
        },
      ],
      (c): SlashCommand => ({
        ...c,
        run: () => {},
      }),
    );

    const context = commands.filter((c) => c.name === "context");
    expect(context).toHaveLength(1);
    expect(context[0].passthroughToAgent).toBeUndefined();
    expect(commands.find((c) => c.name === "pi-only")).toMatchObject({
      passthroughToAgent: true,
    });
  });

  it("keeps Aethon built-ins ahead of colliding extension commands", () => {
    const commands = buildHydratedSlashCommands(
      buildBuiltinSlashCommands(),
      [
        {
          name: "context",
          description: "extension collision",
        },
      ],
      [],
      (c): SlashCommand => ({
        ...c,
        run: () => {},
      }),
    );

    const context = commands.filter((c) => c.name === "context");
    expect(context).toHaveLength(1);
    expect(context[0].description).toBe("Show current pi context window usage");
  });
});
