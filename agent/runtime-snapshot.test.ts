import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type TabRecord,
} from "./state";
import { getRuntimeSnapshot, scheduleStateFileWrite } from "./runtime-snapshot";

function makeOpts(userDir: string): AethonAgentStateOptions {
  return {
    userDir,
    stateFile: join(userDir, "state.json"),
    sessionsDir: join(userDir, "sessions"),
    docsDir: undefined,
    projectRoot: undefined,
    releaseMode: false,
    bootLayoutFile: undefined,
    layoutSlotsFile: undefined,
    statePayloadWarnBytes: 64 * 1024,
    statePayloadHardBytes: 512 * 1024,
    statePayloadWarnKb: 64,
    statePayloadHardKb: 512,
  };
}

describe("getRuntimeSnapshot", () => {
  it("returns the expected shape with empty registries", () => {
    const state = new AethonAgentState(makeOpts("/tmp/aethon-rs"));
    const snap = getRuntimeSnapshot(state);
    expect(snap.release).toBe(false);
    expect(snap.userDir).toBe("/tmp/aethon-rs");
    expect(snap.extensions).toEqual([]);
    expect(snap.themes).toEqual([]);
    expect(snap.components).toEqual([]);
    expect(snap.subagents).toEqual([]);
    expect(snap.tabs).toEqual([]);
    expect(snap.eventRoutingMode).toBe("builtin");
    expect(snap.layoutStructure).toBeNull();
    expect(snap.layoutSlots).toBeNull();
  });

  it("reflects loaded extensions, themes, components", () => {
    const state = new AethonAgentState(makeOpts("/tmp/aethon-rs"));
    state.loadedExtensions.set("hello", "directory");
    state.extensionThemes.set("twilight", {
      id: "twilight",
      label: "Twilight",
      vars: {},
    });
    state.extensionComponents.set("card-x", { type: "card" });
    const snap = getRuntimeSnapshot(state);
    expect(snap.extensions).toEqual([{ name: "hello", source: "directory" }]);
    expect(snap.themes).toEqual([{ id: "twilight", label: "Twilight" }]);
    expect(snap.components).toEqual(["card-x"]);
  });

  it("includes configured subagents", () => {
    const state = new AethonAgentState(makeOpts("/tmp/aethon-sa"));
    // The snapshot reads the active project's cwd cache (currentProjectCwd is
    // null here, so the resolver keys on ""). Seed it directly.
    state.subagentsByCwd.set("", {
      byName: new Map([
        [
          "reviewer",
          {
            name: "reviewer",
            description: "Reviews diffs",
            model: "ollama/llama3.3",
            surface: "inline",
            systemPrompt: "You review.",
            scope: "user",
            filePath: "/agents/reviewer.md",
          },
        ],
        [
          "builder",
          {
            name: "builder",
            description: "Builds features",
            surface: "tab",
            systemPrompt: "You build.",
            scope: "project",
            filePath: "/proj/.aethon/agents/builder.md",
          },
        ],
      ]),
      issues: [],
    });
    const snap = getRuntimeSnapshot(state);
    expect(snap.subagents).toEqual([
      {
        name: "reviewer",
        description: "Reviews diffs",
        model: "ollama/llama3.3",
        surface: "inline",
      },
      { name: "builder", description: "Builds features", surface: "tab" },
    ]);
  });

  it("annotates each tab with its per-tab working directory", () => {
    const state = new AethonAgentState(makeOpts("/tmp/aethon-rs"));
    state.tabProjectCwds.set("t1", "/work/repo");
    state.tabs.set("t1", {
      id: "t1",
      session: { model: null, messages: [] },
    } as unknown as TabRecord);
    // A tab with no recorded cwd omits the field entirely (no `cwd: undefined`).
    state.tabs.set("t2", {
      id: "t2",
      session: { model: null, messages: [] },
    } as unknown as TabRecord);
    const snap = getRuntimeSnapshot(state);
    expect(snap.tabs).toEqual([
      { id: "t1", model: "", messageCount: 0, cwd: "/work/repo" },
      { id: "t2", model: "", messageCount: 0 },
    ]);
  });

  it("includes layout structure when boot layout is loaded", () => {
    const state = new AethonAgentState(makeOpts("/tmp/aethon-rs"));
    state.bootLayout = {
      components: [
        {
          id: "root",
          type: "grid",
          props: { columns: "1fr", areas: ["a"] },
          children: [{ id: "c1", type: "card", props: { area: "a" } }],
        },
      ],
    };
    const snap = getRuntimeSnapshot(state);
    expect(snap.layoutStructure).toMatchObject({
      rootId: "root",
      rootType: "grid",
      children: [{ id: "c1", type: "card", area: "a" }],
    });
  });
});

describe("scheduleStateFileWrite", () => {
  it("debounces writes and produces a JSON file", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-rs-"));
    try {
      const state = new AethonAgentState(makeOpts(root));
      // Burst of three schedules — only one write happens.
      scheduleStateFileWrite(state);
      scheduleStateFileWrite(state);
      scheduleStateFileWrite(state);
      // Wait past the debounce + flush.
      await new Promise((r) => setTimeout(r, 350));
      const text = readFileSync(state.stateFile, "utf8");
      const parsed = JSON.parse(text);
      expect(parsed.userDir).toBe(root);
      expect(state.stateFileTimer).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
