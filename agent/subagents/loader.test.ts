import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSubagents,
  projectAgentsDir,
  refreshSubagents,
  userAgentsDir,
} from "./loader";
import type { AethonAgentState } from "../state";
import type { Subagent, SubagentLoadIssue } from "./types";

let root: string;
let userDir: string;
let projectCwd: string;

function writeAgent(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

const def = (description: string, model?: string) =>
  `---\ndescription: ${description}\n${model ? `model: ${model}\n` : ""}---\nsystem prompt for ${description}`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aethon-subagents-"));
  userDir = join(root, "user");
  projectCwd = join(root, "project");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectCwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadSubagents", () => {
  it("returns an empty registry when no dirs exist", () => {
    const { byName, issues } = loadSubagents({ userDir, projectCwd });
    expect(byName.size).toBe(0);
    expect(issues).toEqual([]);
  });

  it("loads user-scope subagents", () => {
    writeAgent(
      userAgentsDir(userDir),
      "reviewer.md",
      def("Reviews diffs", "ollama/llama3.3"),
    );
    const { byName } = loadSubagents({ userDir, projectCwd });
    expect(byName.size).toBe(1);
    const sub = byName.get("reviewer");
    expect(sub?.scope).toBe("user");
    expect(sub?.model).toBe("ollama/llama3.3");
    expect(sub?.description).toBe("Reviews diffs");
  });

  it("project scope overrides user scope by name", () => {
    writeAgent(
      userAgentsDir(userDir),
      "reviewer.md",
      def("User reviewer", "openai/gpt-5.5"),
    );
    writeAgent(
      projectAgentsDir(projectCwd),
      "reviewer.md",
      def("Project reviewer", "ollama/llama3.3"),
    );
    const { byName } = loadSubagents({ userDir, projectCwd });
    expect(byName.size).toBe(1);
    const sub = byName.get("reviewer");
    expect(sub?.scope).toBe("project");
    expect(sub?.description).toBe("Project reviewer");
    expect(sub?.model).toBe("ollama/llama3.3");
  });

  it("merges distinct names across scopes", () => {
    writeAgent(userAgentsDir(userDir), "reviewer.md", def("Reviews"));
    writeAgent(projectAgentsDir(projectCwd), "planner.md", def("Plans"));
    const { byName } = loadSubagents({ userDir, projectCwd });
    expect([...byName.keys()].sort()).toEqual(["planner", "reviewer"]);
  });

  it("ignores project scope when projectCwd is null", () => {
    writeAgent(userAgentsDir(userDir), "reviewer.md", def("Reviews"));
    writeAgent(projectAgentsDir(projectCwd), "planner.md", def("Plans"));
    const { byName } = loadSubagents({ userDir, projectCwd: null });
    expect([...byName.keys()]).toEqual(["reviewer"]);
  });

  it("records an issue for an unsafe filename and keeps going", () => {
    writeAgent(userAgentsDir(userDir), "Bad Name.md", def("nope"));
    writeAgent(userAgentsDir(userDir), "good.md", def("ok"));
    const { byName, issues } = loadSubagents({ userDir, projectCwd });
    expect(byName.has("good")).toBe(true);
    expect(issues).toHaveLength(1);
    expect(issues[0].error).toMatch(/invalid subagent filename/);
  });

  it("records an issue for a malformed definition", () => {
    writeAgent(userAgentsDir(userDir), "broken.md", "no frontmatter here");
    const { byName, issues } = loadSubagents({ userDir, projectCwd });
    expect(byName.size).toBe(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].scope).toBe("user");
    expect(issues[0].error).toMatch(/frontmatter/);
  });

  it("records an issue for an oversized file", () => {
    const big = `---\ndescription: big\n---\n${"x".repeat(70 * 1024)}`;
    writeAgent(userAgentsDir(userDir), "big.md", big);
    const { byName, issues } = loadSubagents({ userDir, projectCwd });
    expect(byName.size).toBe(0);
    expect(issues[0].error).toMatch(/too large/);
  });

  it("skips dotfiles and non-markdown files", () => {
    const dir = userAgentsDir(userDir);
    writeAgent(dir, ".hidden.md", def("hidden"));
    writeAgent(dir, "notes.txt", def("text"));
    writeAgent(dir, "real.md", def("real"));
    const { byName } = loadSubagents({ userDir, projectCwd });
    expect([...byName.keys()]).toEqual(["real"]);
  });
});

describe("refreshSubagents", () => {
  /** Minimal state stub — refreshSubagents only reads userDir +
   *  currentProjectCwd and writes the subagents map + issues. */
  function stubState(): AethonAgentState {
    return {
      userDir,
      currentProjectCwd: projectCwd,
      subagents: new Map<string, Subagent>(),
      subagentIssues: [] as SubagentLoadIssue[],
    } as unknown as AethonAgentState;
  }

  it("populates state and replaces stale entries on re-run", () => {
    writeAgent(userAgentsDir(userDir), "reviewer.md", def("Reviews"));
    const state = stubState();
    refreshSubagents(state);
    expect(state.subagents.get("reviewer")?.description).toBe("Reviews");

    // Stale entry must be dropped after the source file is removed.
    rmSync(join(userAgentsDir(userDir), "reviewer.md"));
    writeAgent(userAgentsDir(userDir), "planner.md", def("Plans"));
    refreshSubagents(state);
    expect(state.subagents.has("reviewer")).toBe(false);
    expect(state.subagents.get("planner")?.description).toBe("Plans");
    expect(state.subagentIssues).toEqual([]);
  });
});
