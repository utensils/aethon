import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AethonAgentState } from "../state";
import { buildMemoryTools } from "./tools";

function tool(name: string) {
  const userDir = mkdtempSync(join(tmpdir(), "aethon-memory-tools-"));
  const state = new AethonAgentState({
    userDir,
    stateFile: join(userDir, "state.json"),
    sessionsDir: join(userDir, "sessions"),
    releaseMode: false,
  });
  state.tabProjectCwds.set("tab-1", join(userDir, "repo"));
  const found = buildMemoryTools(state, "tab-1").find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return { found, state, userDir };
}

describe("buildMemoryTools", () => {
  it("advertises remember/always behavior in the prompt snippet", () => {
    const { found } = tool("remember");
    expect(found.promptSnippet).toContain("remember");
    expect(found.promptSnippet).toContain("Always");
  });

  it("stores and reads project memory", async () => {
    const { found: remember, state } = tool("remember");
    const read = buildMemoryTools(state, "tab-1").find((t) => t.name === "readMemory");
    if (!read) throw new Error("missing readMemory");

    await remember.execute("call-1", {
      scope: "project",
      kind: "instruction",
      text: "Always use bun for frontend package commands.",
    });
    const result = await read.execute("call-2", { scope: "project" });

    expect(result.content[0]?.text).toContain("Always use bun");
  });
});
