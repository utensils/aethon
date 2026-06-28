import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type TabRecord,
} from "./state";
import { getRuntimeSnapshot, scheduleStateFileWrite } from "./runtime-snapshot";

const { writeFileMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: writeFileMock,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    expect(snap.highlightGrammars).toEqual([]);
    expect(snap.nativeWindows).toEqual([]);
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
    state.extensionHighlightGrammars.set("lean", {
      lang: "lean",
      grammar: { scopeName: "source.lean" },
    });
    state.extensionHighlightGrammars.set("unicode", {
      lang: "unicode",
      grammar: { scopeName: "source.é" },
    });
    const circular: Record<string, unknown> = { scopeName: "source.circular" };
    circular.self = circular;
    state.extensionHighlightGrammars.set("circular", {
      lang: "circular",
      grammar: circular,
    });
    const snap = getRuntimeSnapshot(state);
    expect(snap.extensions).toEqual([{ name: "hello", source: "directory" }]);
    expect(snap.themes).toEqual([{ id: "twilight", label: "Twilight" }]);
    expect(snap.components).toEqual(["card-x"]);
    expect(snap.highlightGrammars).toEqual([
      {
        lang: "lean",
        bytes: Buffer.byteLength(
          JSON.stringify({ scopeName: "source.lean" }),
          "utf8",
        ),
      },
      {
        lang: "unicode",
        bytes: Buffer.byteLength(
          JSON.stringify({ scopeName: "source.é" }),
          "utf8",
        ),
      },
      { lang: "circular", bytes: 0 },
    ]);
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

  it("includes native canvas window summaries", () => {
    const state = new AethonAgentState(makeOpts("/tmp/aethon-rs"));
    state.nativeWindows.set("Workpad", {
      id: "Workpad",
      label: "aethon-canvas-Workpad",
      kind: "canvas",
      title: "Workpad",
      tabId: "default",
      restoreOnLaunch: true,
      componentCount: 2,
    });
    const snap = getRuntimeSnapshot(state);
    expect(snap.nativeWindows).toEqual([
      {
        id: "Workpad",
        label: "aethon-canvas-Workpad",
        kind: "canvas",
        title: "Workpad",
        tabId: "default",
        restoreOnLaunch: true,
        componentCount: 2,
      },
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
  beforeEach(() => {
    vi.useFakeTimers();
    writeFileMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces writes and produces a JSON payload", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-rs-"));
    try {
      const state = new AethonAgentState(makeOpts(root));
      // Burst of three schedules — only one write happens.
      scheduleStateFileWrite(state);
      scheduleStateFileWrite(state);
      scheduleStateFileWrite(state);
      await vi.advanceTimersByTimeAsync(STATE_FILE_DEBOUNCE_MS_FOR_TEST);
      expect(writeFileMock).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(writeFileMock.mock.calls[0][1] as string);
      expect(parsed.userDir).toBe(root);
      expect(state.stateFileTimer).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not drop mutations scheduled while a state-file write is in flight", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-rs-"));
    try {
      const state = new AethonAgentState(makeOpts(root));
      state.loadedExtensions.set("first", "directory");
      const firstWrite = deferred<void>();
      writeFileMock.mockImplementationOnce(() => firstWrite.promise);

      scheduleStateFileWrite(state);
      await vi.advanceTimersByTimeAsync(STATE_FILE_DEBOUNCE_MS_FOR_TEST);
      expect(writeFileMock).toHaveBeenCalledTimes(1);

      state.loadedExtensions.set("second", "directory");
      scheduleStateFileWrite(state);
      await vi.advanceTimersByTimeAsync(STATE_FILE_DEBOUNCE_MS_FOR_TEST);
      expect(writeFileMock).toHaveBeenCalledTimes(1);
      expect(state.stateFileDirty).toBe(true);

      firstWrite.resolve();
      await firstWrite.promise;
      await Promise.resolve();
      expect(writeFileMock).toHaveBeenCalledTimes(2);
      const latest = JSON.parse(writeFileMock.mock.calls[1][1] as string);
      expect(latest.extensions).toEqual([
        { name: "first", source: "directory" },
        { name: "second", source: "directory" },
      ]);
      expect(state.stateFileDirty).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const STATE_FILE_DEBOUNCE_MS_FOR_TEST = 200;
