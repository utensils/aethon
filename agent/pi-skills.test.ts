import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { discoverPiSkills } from "./pi-skills";

describe("discoverPiSkills", () => {
  it("reads skill metadata from SKILL.md frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aethon-pi-skills-"));
    await mkdir(join(dir, "claudex"));
    await writeFile(
      join(dir, "claudex", "SKILL.md"),
      [
        "---",
        "name: claudex",
        "description: Query Claude Code session history.",
        "argument-hint: [subcommand or query]",
        "---",
        "",
        "# claudex",
      ].join("\n"),
    );

    await mkdir(join(dir, "9invalid"));
    await writeFile(join(dir, "9invalid", "SKILL.md"), "# invalid");

    expect(await discoverPiSkills(dir)).toEqual([
      {
        name: "claudex",
        description: "Query Claude Code session history.",
        usage: "[subcommand or query]",
      },
    ]);
  });
});
