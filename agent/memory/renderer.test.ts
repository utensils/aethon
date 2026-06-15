import { describe, expect, it } from "vitest";
import { renderMemoryPromptSection } from "./renderer";
import type { ResolvedMemoryContext } from "./types";

function ctx(overrides: Partial<ResolvedMemoryContext> = {}): ResolvedMemoryContext {
  return {
    user: {
      scope: "user",
      dir: "/home/me/.aethon/memory/user",
      memoryPath: "/home/me/.aethon/memory/user/MEMORY.md",
      topicsDir: "/home/me/.aethon/memory/user/topics",
    },
    project: {
      scope: "project",
      dir: "/home/me/.aethon/memory/projects/aethon-abc",
      memoryPath: "/home/me/.aethon/memory/projects/aethon-abc/MEMORY.md",
      topicsDir: "/home/me/.aethon/memory/projects/aethon-abc/topics",
      project: {
        id: "aethon-abc",
        key: "aethon-project:p1:/repo/aethon",
        root: "/repo/aethon",
        label: "aethon",
        source: "aethon-workspace",
        resolvedFromCwd: "/repo/aethon/.aethon/workspaces/feat-x",
      },
    },
    userMemory: "- Prefer concise replies\n",
    projectMemory: "- Use bun for frontend commands\n",
    ...overrides,
  };
}

describe("renderMemoryPromptSection", () => {
  it("renders user memory before project memory and includes resolved project metadata", () => {
    const out = renderMemoryPromptSection(ctx());

    expect(out).toContain("# Aethon memory");
    expect(out.indexOf("## User memory")).toBeLessThan(out.indexOf("## Project memory"));
    expect(out).toContain("- Prefer concise replies");
    expect(out).toContain("- Use bun for frontend commands");
    expect(out).toContain("Resolved project: `aethon` at `/repo/aethon`");
    expect(out).toContain("scope source: `aethon-workspace`");
  });

  it("omits the section when both memory files are empty", () => {
    expect(renderMemoryPromptSection(ctx({ userMemory: "", projectMemory: "" }))).toBe("");
  });

  it("caps loaded memory by line count and bytes", () => {
    const manyLines = Array.from({ length: 205 }, (_, i) => `- line ${i + 1}`).join("\n");
    const out = renderMemoryPromptSection(ctx({ userMemory: manyLines, projectMemory: "", maxLines: 200 }));

    expect(out).toContain("- line 200");
    expect(out).not.toContain("- line 201");
    expect(out).toContain("truncated");

    const bytesOut = renderMemoryPromptSection(
      ctx({ userMemory: "abcdef", projectMemory: "", maxLines: 200, maxBytes: 3 }),
    );
    expect(bytesOut).toContain("abc");
    expect(bytesOut).not.toContain("abcdef");
    expect(bytesOut).toContain("truncated");
  });
});
