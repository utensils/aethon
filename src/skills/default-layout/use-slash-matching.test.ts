import { describe, expect, it } from "vitest";
import {
  matchSlashCommand,
  normalizeArgChoices,
  resolveSlashCommands,
} from "./use-slash-matching";

describe("normalizeArgChoices", () => {
  it("accepts strings, value objects, and id objects", () => {
    expect(
      normalizeArgChoices([
        "main",
        { value: "dev", label: "Development" },
        { id: "prod", description: "Production" },
        { label: "missing value" },
      ]),
    ).toEqual([
      { value: "main" },
      { value: "dev", label: "Development" },
      { value: "prod", description: "Production" },
    ]);
  });
});

describe("resolveSlashCommands", () => {
  it("resolves inline and state-bound command lists", () => {
    const inline = [{ name: "clear" }];
    expect(resolveSlashCommands(inline, {})).toBe(inline);
    expect(
      resolveSlashCommands({ $ref: "/slashCommands" }, {
        slashCommands: [{ name: "theme" }],
      }),
    ).toEqual([{ name: "theme" }]);
    expect(resolveSlashCommands({ $ref: "/missing" }, {})).toEqual([]);
  });
});

describe("matchSlashCommand", () => {
  it("matches command prefixes by slash name", () => {
    const match = matchSlashCommand(
      "/th",
      [
        { name: "clear" },
        { name: "theme", description: "Switch theme" },
      ],
      {},
    );

    expect(match).toMatchObject({
      mode: "command",
      prefix: "th",
      matches: [{ kind: "command", cmd: { name: "theme" } }],
    });
  });

  it("matches argument choices from a command arg source", () => {
    const match = matchSlashCommand(
      "/theme da",
      [{ name: "theme", argSource: "/themes" }],
      {
        themes: [
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "System" },
        ],
      },
    );

    expect(match).toMatchObject({
      mode: "arg",
      prefix: "da",
      cmd: { name: "theme" },
      matches: [
        {
          kind: "arg",
          cmd: { name: "theme" },
          choice: { value: "dark", label: "Dark" },
        },
      ],
    });
  });

  it("ignores unknown commands and multi-line argument drafts", () => {
    expect(matchSlashCommand("/missing x", [], {})).toBeNull();
    expect(
      matchSlashCommand(
        "/theme dark\nextra",
        [{ name: "theme", argSource: "/themes" }],
        { themes: ["dark"] },
      ),
    ).toBeNull();
  });
});
