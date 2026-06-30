import { describe, expect, it } from "vitest";
import { parseSessionHistoryLines } from "./parse-pi";

function messageLine(id: string, role: "user" | "assistant", content: string): string {
  return JSON.stringify({
    type: "message",
    id,
    message: { role, content },
  });
}

describe("parseSessionHistoryLines", () => {
  it("keeps the full restored transcript instead of dropping early turns", () => {
    const lines = Array.from({ length: 240 }, (_, index) =>
      messageLine(`u${index}`, "user", `message ${index}`),
    );

    const restored = parseSessionHistoryLines(lines);

    expect(restored).toHaveLength(240);
    expect(restored[0]).toMatchObject({
      id: "u0",
      entryId: "u0",
      role: "user",
      text: "message 0",
    });
    expect(restored.at(-1)).toMatchObject({
      id: "u239",
      entryId: "u239",
      role: "user",
      text: "message 239",
    });
  });

  it("strips expanded @file context from restored user display text", () => {
    const expanded = [
      "Review @README.md",
      "",
      '<aethon_file_references cwd="/repo">',
      "context",
      '<file path="README.md" bytes="4">',
      "```md",
      "# Hi",
      "```",
      "</file>",
      "</aethon_file_references>",
    ].join("\n");

    expect(parseSessionHistoryLines([messageLine("u1", "user", expanded)]))
      .toEqual([
        {
          id: "u1",
          entryId: "u1",
          role: "user",
          text: "Review @README.md",
        },
      ]);
  });
});
