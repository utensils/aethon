import { describe, expect, it } from "vitest";
import type { SlashCommand } from "../../slashCommands";
import { buildHydratedSlashCommands } from "./slashCommands";

const builtins: SlashCommand[] = [
  {
    name: "mcp",
    description: "Aethon MCP",
    run: () => {},
  },
  {
    name: "mcp-auth",
    description: "Aethon MCP auth",
    run: () => {},
  },
];

describe("buildHydratedSlashCommands", () => {
  it("hides pi adapter MCP aliases behind Aethon's local MCP command", () => {
    const commands = buildHydratedSlashCommands(
      builtins,
      [],
      [
        { name: "mcp:1", description: "Show MCP server status" },
        { name: "mcp-auth:1", description: "Authenticate MCP server" },
        { name: "memory", description: "Memory" },
      ],
      (command) => ({ ...command, run: () => {} }),
    );

    expect(commands.map((command) => command.name)).toEqual([
      "mcp",
      "mcp-auth",
      "memory",
    ]);
  });
});
