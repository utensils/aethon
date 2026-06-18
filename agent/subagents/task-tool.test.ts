import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AethonAgentState } from "../state";
import type { Subagent } from "./types";
import { buildSubagentTaskBatchTool, buildSubagentTaskTool } from "./task-tool";

const fakeModel = { provider: "ollama", id: "llama3.3", name: "Llama 3.3" };

// Hoisted handle so the vi.mock factory and the tests share the same scripting
// surface for the fake pi session.
interface MockSessionHandle {
  subscribers: Array<(e: Record<string, unknown>) => void>;
  scriptedEvents: Array<Record<string, unknown>>;
  promptImpl: null | ((session: MockSessionHandle) => Promise<void>);
  lastConfig: Record<string, unknown> | undefined;
  lastPrompt: string | undefined;
  disposeSpy: ReturnType<typeof vi.fn>;
  abortSpy: ReturnType<typeof vi.fn>;
}

interface MockHandle {
  subscribers: Array<(e: Record<string, unknown>) => void>;
  scriptedEvents: Array<Record<string, unknown>>;
  promptImpl: null | ((session: MockSessionHandle) => Promise<void>);
  lastConfig: Record<string, unknown> | undefined;
  lastPrompt: string | undefined;
  sessions: MockSessionHandle[];
  nextSessions: Array<
    Partial<Pick<MockSessionHandle, "scriptedEvents" | "promptImpl">>
  >;
  createAgentSession: ReturnType<typeof vi.fn>;
  disposeSpy: ReturnType<typeof vi.fn>;
  abortSpy: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted<MockHandle>(() => ({
  subscribers: [],
  scriptedEvents: [],
  promptImpl: null,
  lastConfig: undefined,
  lastPrompt: undefined,
  sessions: [],
  nextSessions: [],
  createAgentSession: vi.fn(),
  disposeSpy: vi.fn(),
  abortSpy: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => {
  const createAgentSession = vi.fn((config: Record<string, unknown>) => {
    const next = h.nextSessions.shift() ?? {};
    const handle: MockSessionHandle = {
      subscribers: [],
      scriptedEvents: next.scriptedEvents ?? [...h.scriptedEvents],
      promptImpl: next.promptImpl ?? h.promptImpl,
      lastConfig: config,
      lastPrompt: undefined,
      disposeSpy: vi.fn(),
      abortSpy: vi.fn(() => Promise.resolve()),
    };
    h.sessions.push(handle);
    h.subscribers = handle.subscribers;
    h.lastConfig = config;
    h.disposeSpy = handle.disposeSpy;
    h.abortSpy = handle.abortSpy;
    const session = {
      model: config.model,
      subscribe(fn: (e: Record<string, unknown>) => void) {
        handle.subscribers.push(fn);
        return () => {
          const i = handle.subscribers.indexOf(fn);
          if (i >= 0) handle.subscribers.splice(i, 1);
        };
      },
      prompt(prompt: string): Promise<void> {
        handle.lastPrompt = prompt;
        h.lastPrompt = prompt;
        if (handle.promptImpl) return handle.promptImpl(handle);
        for (const ev of handle.scriptedEvents) {
          for (const s of [...handle.subscribers]) s(ev);
        }
        return Promise.resolve();
      },
      abort: handle.abortSpy,
      dispose: handle.disposeSpy,
    };
    return Promise.resolve({ session });
  });
  h.createAgentSession = createAgentSession;
  return {
    defineTool: (spec: unknown) => spec,
    SessionManager: { inMemory: () => ({ __inMemory: true }) },
    createBashToolDefinition: () => ({ name: "bash" }),
    createAgentSession,
  };
});

type ExecResult = {
  content: { type: string; text: string }[];
  details: { subagent: string; model: string; surface: string };
};
type Exec = (
  callId: string,
  params: {
    subagent_type: string;
    prompt: string;
    context?: string;
    surface?: "inline" | "background" | "auto";
  },
  signal?: AbortSignal,
  onUpdate?: (p: { content: { type: string; text: string }[] }) => void,
) => Promise<ExecResult>;
type BatchExec = (
  callId: string,
  params: {
    tasks: Array<{ subagent_type: string; prompt: string; context?: string }>;
    surface?: "inline" | "background" | "auto";
  },
  signal?: AbortSignal,
  onUpdate?: (p: { content: { type: string; text: string }[] }) => void,
) => Promise<ExecResult>;

function execOf(tool: ToolDefinition): Exec {
  return (tool as unknown as { execute: Exec }).execute;
}

function batchExecOf(tool: ToolDefinition): BatchExec {
  return (tool as unknown as { execute: BatchExec }).execute;
}

function makeState(sub: Partial<Subagent> & { name: string }): {
  state: AethonAgentState;
  findSpy: ReturnType<typeof vi.fn>;
} {
  return makeStateWithSubagents([sub]);
}

function makeStateWithSubagents(
  subs: Array<Partial<Subagent> & { name: string }>,
): {
  state: AethonAgentState;
  findSpy: ReturnType<typeof vi.fn>;
} {
  const full = subs.map(
    (sub): Subagent => ({
      name: sub.name,
      description: sub.description ?? "does things",
      model: sub.model,
      tools: sub.tools,
      surface: sub.surface ?? "inline",
      timeoutSeconds: sub.timeoutSeconds,
      systemPrompt: sub.systemPrompt ?? `You are ${sub.name}.`,
      scope: "user",
      filePath: `/agents/${sub.name}.md`,
    }),
  );
  const findSpy = vi.fn((_provider: string, _id: string) => fakeModel);
  const state = {
    subagentsByCwd: new Map([
      [
        "/proj",
        {
          byName: new Map(full.map((sub) => [sub.name, sub])),
          issues: [],
        },
      ],
    ]),
    tabProjectCwds: new Map<string, string>(),
    tabAuthProfileIds: new Map<string, string>(),
    currentProjectCwd: "/proj",
    tabs: new Map([["default", { session: { model: fakeModel } }]]),
    authProfiles: { version: 1, profiles: [], defaultByProvider: {} },
    authStorage: {},
    modelRegistry: { find: findSpy },
    settingsManager: {
      getDefaultProvider: () => undefined,
      getDefaultModel: () => undefined,
    },
    resourceLoader: {},
    bashTimeoutFloorSeconds: 300,
    subagentTimeoutSeconds: 300,
  } as unknown as AethonAgentState;
  return { state, findSpy };
}

const successEvents = [
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Found " },
  },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "2 bugs." },
  },
  {
    type: "agent_end",
    messages: [{ role: "assistant", content: [], stopReason: "stop" }],
  },
];

function emitSessionEvents(
  session: MockSessionHandle,
  events: Array<Record<string, unknown>>,
) {
  for (const event of events) {
    for (const subscriber of [...session.subscribers]) subscriber(event);
  }
}

beforeEach(() => {
  h.subscribers = [];
  h.scriptedEvents = [...successEvents];
  h.promptImpl = null;
  h.lastConfig = undefined;
  h.lastPrompt = undefined;
  h.sessions = [];
  h.nextSessions = [];
  h.createAgentSession.mockClear();
});

afterEach(() => {
  delete (globalThis as { aethon?: unknown }).aethon;
  vi.useRealTimers();
});

describe("buildSubagentTaskTool", () => {
  it("runs an inline subagent on its configured model and returns its text", async () => {
    const { state } = makeState({ name: "reviewer", model: "ollama/llama3.3" });
    const send = vi.fn();
    const onUpdate = vi.fn();
    const tool = buildSubagentTaskTool(state, { send }, "default");

    const result = await execOf(tool)(
      "call-1",
      { subagent_type: "reviewer", prompt: "check src/foo.ts" },
      undefined,
      onUpdate,
    );

    expect(result.content[0].text).toBe("Found 2 bugs.");
    expect(result.details).toEqual({
      subagent: "reviewer",
      model: "ollama/llama3.3",
      surface: "inline",
    });
    // Model + in-memory session + bash shadow passed to pi.
    expect(h.lastConfig?.model).toBe(fakeModel);
    expect(h.lastConfig?.sessionManager).toEqual({ __inMemory: true });
    expect(h.lastConfig?.customTools).toEqual([{ name: "bash" }]);
    // Live streaming surfaced.
    expect(onUpdate).toHaveBeenCalled();
    const phases = send.mock.calls
      .map((c) => c[0] as { type?: string; phase?: string })
      .filter((m) => m.type === "subagent_progress")
      .map((m) => m.phase);
    expect(phases).toContain("start");
    expect(phases).toContain("text");
    expect(phases).toContain("done");
    expect(h.disposeSpy).toHaveBeenCalled();
  });

  it("keeps concurrent inline subagent runs isolated by call id", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    h.nextSessions = [
      {
        promptImpl: (session) =>
          new Promise<void>((resolve) => {
            releaseA = () => {
              emitSessionEvents(session, [
                {
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "text_delta",
                    delta: "A done",
                  },
                },
                {
                  type: "agent_end",
                  messages: [
                    { role: "assistant", content: [], stopReason: "stop" },
                  ],
                },
              ]);
              resolve();
            };
          }),
      },
      {
        promptImpl: (session) =>
          new Promise<void>((resolve) => {
            releaseB = () => {
              emitSessionEvents(session, [
                {
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "text_delta",
                    delta: "B done",
                  },
                },
                {
                  type: "agent_end",
                  messages: [
                    { role: "assistant", content: [], stopReason: "stop" },
                  ],
                },
              ]);
              resolve();
            };
          }),
      },
    ];
    const { state } = makeState({ name: "reviewer", model: "ollama/llama3.3" });
    const send = vi.fn();
    const tool = buildSubagentTaskTool(state, { send }, "default");

    const first = execOf(tool)("call-a", {
      subagent_type: "reviewer",
      prompt: "first task",
    });
    const second = execOf(tool)("call-b", {
      subagent_type: "reviewer",
      prompt: "second task",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0]?.lastPrompt).toContain("first task");
    expect(h.sessions[1]?.lastPrompt).toContain("second task");

    releaseB();
    await expect(second).resolves.toMatchObject({
      content: [{ type: "text", text: "B done" }],
      details: { subagent: "reviewer" },
    });
    expect(h.sessions[1]?.disposeSpy).toHaveBeenCalledTimes(1);
    expect(h.sessions[0]?.disposeSpy).not.toHaveBeenCalled();

    releaseA();
    await expect(first).resolves.toMatchObject({
      content: [{ type: "text", text: "A done" }],
      details: { subagent: "reviewer" },
    });
    expect(h.sessions[0]?.disposeSpy).toHaveBeenCalledTimes(1);

    const progress = send.mock.calls
      .map(
        (c) => c[0] as { type?: string; parentCallId?: string; phase?: string },
      )
      .filter((m) => m.type === "subagent_progress");
    expect(
      progress.filter((m) => m.parentCallId === "call-a").map((m) => m.phase),
    ).toEqual(["start", "text", "done"]);
    expect(
      progress.filter((m) => m.parentCallId === "call-b").map((m) => m.phase),
    ).toEqual(["start", "text", "done"]);
  });

  it("expands @file references before sending the task to an inline subagent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aethon-task-file-ref-"));
    try {
      await writeFile(join(cwd, "foo.ts"), "export const foo = 1;\n");
      const { state } = makeState({
        name: "reviewer",
        model: "ollama/llama3.3",
      });
      const registry = state.subagentsByCwd.get("/proj");
      state.currentProjectCwd = cwd;
      state.subagentsByCwd = new Map([[cwd, registry]]);
      const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");

      await execOf(tool)("c", {
        subagent_type: "reviewer",
        prompt: "check @foo.ts",
      });

      expect(h.lastPrompt).toContain("<aethon_file_references");
      expect(h.lastPrompt).toContain("export const foo = 1");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("expands prompt and context in a single deduped file-references block", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aethon-task-file-ref-dedup-"));
    try {
      await writeFile(join(cwd, "foo.ts"), "export const foo = 1;\n");
      const { state } = makeState({
        name: "reviewer",
        model: "ollama/llama3.3",
      });
      const registry = state.subagentsByCwd.get("/proj");
      state.currentProjectCwd = cwd;
      state.subagentsByCwd = new Map([[cwd, registry]]);
      const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");

      await execOf(tool)("c", {
        subagent_type: "reviewer",
        prompt: "check @foo.ts",
        context: "Background: @foo.ts matters.",
      });

      // The same file referenced in both prompt and context must yield ONE
      // <aethon_file_references> block, not one per field.
      const blocks =
        (h.lastPrompt ?? "").split("<aethon_file_references").length - 1;
      expect(blocks).toBe(1);
      expect(h.lastPrompt).toContain("export const foo = 1");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("passes a tools allowlist through to the session", async () => {
    const { state } = makeState({
      name: "reviewer",
      model: "ollama/llama3.3",
      tools: ["read", "grep"],
    });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    await execOf(tool)("c", { subagent_type: "reviewer", prompt: "x" });
    expect(h.lastConfig?.tools).toEqual(["read", "grep"]);
    expect(h.lastConfig?.noTools).toBeUndefined();
  });

  it("locks the subagent to no tools when tools is empty", async () => {
    const { state } = makeState({
      name: "reviewer",
      model: "ollama/llama3.3",
      tools: [],
    });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    await execOf(tool)("c", { subagent_type: "reviewer", prompt: "x" });
    expect(h.lastConfig?.noTools).toBe("all");
    expect(h.lastConfig?.tools).toBeUndefined();
  });

  it("inherits the parent tab's model when none is configured", async () => {
    const { state } = makeState({ name: "helper" });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    const result = await execOf(tool)("c", {
      subagent_type: "helper",
      prompt: "x",
    });
    expect(h.lastConfig?.model).toBe(fakeModel);
    expect(result.details.model).toBe("ollama/llama3.3");
  });

  it("throws on an unknown subagent", async () => {
    const { state } = makeState({ name: "reviewer" });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    await expect(
      execOf(tool)("c", { subagent_type: "ghost", prompt: "x" }),
    ).rejects.toThrow(/unknown subagent/);
  });

  it("throws when the configured model is unavailable", async () => {
    const { state, findSpy } = makeState({
      name: "reviewer",
      model: "ollama/missing",
    });
    findSpy.mockReturnValueOnce(undefined);
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    await expect(
      execOf(tool)("c", { subagent_type: "reviewer", prompt: "x" }),
    ).rejects.toThrow(/not available/);
  });

  it("surfaces an agent_end error as a thrown error", async () => {
    h.scriptedEvents = [
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "model overloaded",
          },
        ],
      },
    ];
    const { state } = makeState({ name: "reviewer", model: "ollama/llama3.3" });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    await expect(
      execOf(tool)("c", { subagent_type: "reviewer", prompt: "x" }),
    ).rejects.toThrow(/model overloaded/);
    expect(h.disposeSpy).toHaveBeenCalled();
  });

  it("wraps a prompt rejection and still disposes", async () => {
    h.promptImpl = () => Promise.reject(new Error("boom"));
    const { state } = makeState({ name: "reviewer", model: "ollama/llama3.3" });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    await expect(
      execOf(tool)("c", { subagent_type: "reviewer", prompt: "x" }),
    ).rejects.toThrow(/failed: boom/);
    expect(h.disposeSpy).toHaveBeenCalled();
  });

  it("aborts the subagent session when the parent signal aborts", async () => {
    let release!: () => void;
    h.promptImpl = () => new Promise<void>((res) => (release = res));
    const { state } = makeState({ name: "reviewer", model: "ollama/llama3.3" });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    const ctrl = new AbortController();
    const pending = execOf(tool)(
      "c",
      { subagent_type: "reviewer", prompt: "x" },
      ctrl.signal,
    );
    // Let the microtasks settle so subscribe + prompt start.
    await Promise.resolve();
    ctrl.abort();
    expect(h.abortSpy).toHaveBeenCalled();
    release();
    await pending;
  });

  it("catches rejected aborts before disposing the subagent session", async () => {
    let release!: () => void;
    h.promptImpl = () => new Promise<void>((res) => (release = res));
    const { state } = makeState({ name: "reviewer", model: "ollama/llama3.3" });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    const ctrl = new AbortController();
    const pending = execOf(tool)(
      "c",
      { subagent_type: "reviewer", prompt: "x" },
      ctrl.signal,
    );
    await Promise.resolve();
    h.abortSpy.mockRejectedValueOnce(new Error("abort failed"));

    ctrl.abort();
    release();

    await expect(pending).resolves.toMatchObject({
      details: { subagent: "reviewer" },
    });
    expect(h.abortSpy).toHaveBeenCalledTimes(1);
    expect(h.disposeSpy).toHaveBeenCalled();
  });

  it("uses the subagent timeout override for inline runs", async () => {
    vi.useFakeTimers();
    h.promptImpl = () => new Promise<void>(() => {});
    const { state } = makeState({
      name: "reviewer",
      model: "ollama/llama3.3",
      timeoutSeconds: 1,
    });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    const pending = execOf(tool)("c", {
      subagent_type: "reviewer",
      prompt: "x",
    });
    const rejection = expect(pending).rejects.toThrow(/timed out after 1s/);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(h.abortSpy).toHaveBeenCalled();
    expect(h.disposeSpy).toHaveBeenCalled();
  });

  it("does not hang forever when timeout abort cleanup never settles", async () => {
    vi.useFakeTimers();
    h.promptImpl = () => new Promise<void>(() => {});
    const { state } = makeState({
      name: "reviewer",
      model: "ollama/llama3.3",
      timeoutSeconds: 1,
    });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    const pending = execOf(tool)("c", {
      subagent_type: "reviewer",
      prompt: "x",
    });
    const rejection = expect(pending).rejects.toThrow(/timed out after 1s/);
    await Promise.resolve();
    h.abortSpy.mockImplementationOnce(() => new Promise<void>(() => {}));

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.abortSpy).toHaveBeenCalled();
    expect(h.disposeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(h.disposeSpy).toHaveBeenCalled();
  });

  it("launches a tab for surface: tab subagents", async () => {
    const start = vi.fn(() =>
      Promise.resolve({ ok: true, data: { tabId: "t2" } }),
    );
    (globalThis as { aethon?: unknown }).aethon = { tasks: { start } };
    const { state } = makeState({
      name: "builder",
      model: "ollama/llama3.3",
      surface: "tab",
    });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    const result = await execOf(tool)("c", {
      subagent_type: "builder",
      prompt: "do it",
    });
    expect(start).toHaveBeenCalledWith({
      projectPath: "/proj",
      prompt: expect.stringContaining("do it"),
      model: "ollama/llama3.3",
    });
    expect(result.details.surface).toBe("tab");
    expect(result.content[0].text).toMatch(/Launched subagent/);
    // No isolated session created for the tab surface.
    expect(h.createAgentSession).not.toHaveBeenCalled();
  });

  it("can force an inline subagent into a background tab", async () => {
    const start = vi.fn(() =>
      Promise.resolve({ ok: true, data: { tabId: "t-bg" } }),
    );
    (globalThis as { aethon?: unknown }).aethon = { tasks: { start } };
    const { state } = makeState({
      name: "builder",
      model: "ollama/llama3.3",
      surface: "inline",
    });
    const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");
    const result = await execOf(tool)("c", {
      subagent_type: "builder",
      prompt: "do it",
      surface: "background",
    });
    expect(start).toHaveBeenCalledWith({
      projectPath: "/proj",
      prompt: expect.stringContaining("do it"),
      model: "ollama/llama3.3",
      activate: false,
      label: expect.stringContaining("builder"),
    });
    expect(result.details.surface).toBe("background");
    expect(result.content[0].text).toMatch(/background tab/);
    expect(h.createAgentSession).not.toHaveBeenCalled();
  });

  it("passes expanded context as a hidden bridge prompt for tab-surface subagents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aethon-task-file-ref-tab-"));
    try {
      await writeFile(join(cwd, "foo.ts"), "export const foo = 1;\n");
      const start = vi.fn(() => Promise.resolve({ ok: true }));
      (globalThis as { aethon?: unknown }).aethon = { tasks: { start } };
      const { state } = makeState({
        name: "builder",
        surface: "tab",
      });
      const registry = state.subagentsByCwd.get("/proj");
      state.currentProjectCwd = cwd;
      state.subagentsByCwd = new Map([[cwd, registry]]);
      const tool = buildSubagentTaskTool(state, { send: vi.fn() }, "default");

      await execOf(tool)("c", {
        subagent_type: "builder",
        prompt: "inspect @foo.ts",
        context: "Use @foo.ts as context.",
      });

      expect(start).toHaveBeenCalledWith({
        projectPath: cwd,
        prompt: expect.stringContaining("inspect @foo.ts"),
        bridgePrompt: expect.stringContaining("<aethon_file_references"),
      });
      expect(start.mock.calls[0]?.[0].prompt).not.toContain(
        "<aethon_file_references",
      );
      expect(h.createAgentSession).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("buildSubagentTaskBatchTool", () => {
  it("runs multiple inline subagents concurrently and returns results in request order", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    h.nextSessions = [
      {
        promptImpl: (session) =>
          new Promise<void>((resolve) => {
            releaseA = () => {
              emitSessionEvents(session, [
                {
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "text_delta",
                    delta: "A done",
                  },
                },
                {
                  type: "agent_end",
                  messages: [
                    { role: "assistant", content: [], stopReason: "stop" },
                  ],
                },
              ]);
              resolve();
            };
          }),
      },
      {
        promptImpl: (session) =>
          new Promise<void>((resolve) => {
            releaseB = () => {
              emitSessionEvents(session, [
                {
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "text_delta",
                    delta: "B done",
                  },
                },
                {
                  type: "agent_end",
                  messages: [
                    { role: "assistant", content: [], stopReason: "stop" },
                  ],
                },
              ]);
              resolve();
            };
          }),
      },
    ];
    const { state } = makeStateWithSubagents([
      { name: "kimi", model: "ollama/llama3.3" },
      { name: "glm-5-2", model: "ollama/llama3.3" },
    ]);
    const send = vi.fn();
    const tool = buildSubagentTaskBatchTool(state, { send }, "default");

    const pending = batchExecOf(tool)("batch-call", {
      tasks: [
        { subagent_type: "kimi", prompt: "first" },
        { subagent_type: "glm-5-2", prompt: "second" },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.sessions).toHaveLength(2);
    releaseB();
    await Promise.resolve();
    releaseA();

    const result = await pending;
    expect(result.content[0].text).toMatch(
      /## kimi[\s\S]*A done[\s\S]*## glm-5-2[\s\S]*B done/,
    );
    const progress = send.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((m) => m.type === "subagent_progress");
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentCallId: "batch-call",
          batchItemId: "0:kimi",
          phase: "start",
        }),
        expect.objectContaining({
          parentCallId: "batch-call",
          batchItemId: "1:glm-5-2",
          phase: "start",
        }),
      ]),
    );
  });

  it("keeps successful batch results when one subagent fails", async () => {
    h.nextSessions = [
      { scriptedEvents: successEvents },
      {
        scriptedEvents: [
          {
            type: "agent_end",
            messages: [
              {
                role: "assistant",
                stopReason: "error",
                errorMessage: "model overloaded",
              },
            ],
          },
        ],
      },
    ];
    const { state } = makeStateWithSubagents([
      { name: "kimi", model: "ollama/llama3.3" },
      { name: "glm-5-2", model: "ollama/llama3.3" },
    ]);
    const tool = buildSubagentTaskBatchTool(
      state,
      { send: vi.fn() },
      "default",
    );

    const result = await batchExecOf(tool)("batch-call", {
      tasks: [
        { subagent_type: "kimi", prompt: "first" },
        { subagent_type: "glm-5-2", prompt: "second" },
      ],
    });

    expect(result.content[0].text).toContain("## kimi");
    expect(result.content[0].text).toContain("Found 2 bugs.");
    expect(result.content[0].text).toContain("## glm-5-2");
    expect(result.content[0].text).toContain("model overloaded");
  });

  it("rejects only when every subagent fails", async () => {
    h.promptImpl = () => Promise.reject(new Error("boom"));
    const { state } = makeStateWithSubagents([
      { name: "kimi", model: "ollama/llama3.3" },
      { name: "glm-5-2", model: "ollama/llama3.3" },
    ]);
    const tool = buildSubagentTaskBatchTool(
      state,
      { send: vi.fn() },
      "default",
    );

    await expect(
      batchExecOf(tool)("batch-call", {
        tasks: [
          { subagent_type: "kimi", prompt: "first" },
          { subagent_type: "glm-5-2", prompt: "second" },
        ],
      }),
    ).rejects.toThrow(/all subagents failed/i);
  });

  it("launches batch tasks as non-focused background tabs when requested", async () => {
    const start = vi.fn(() =>
      Promise.resolve({ ok: true, data: { tabId: crypto.randomUUID() } }),
    );
    (globalThis as { aethon?: unknown }).aethon = { tasks: { start } };
    const { state } = makeStateWithSubagents([
      { name: "kimi", model: "ollama/llama3.3" },
      { name: "glm-5-2", model: "ollama/llama3.3" },
    ]);
    const tool = buildSubagentTaskBatchTool(
      state,
      { send: vi.fn() },
      "default",
    );

    const result = await batchExecOf(tool)("batch-call", {
      surface: "background",
      tasks: [
        { subagent_type: "kimi", prompt: "first" },
        { subagent_type: "glm-5-2", prompt: "second" },
      ],
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ activate: false, label: expect.stringContaining("kimi") }),
      expect.objectContaining({
        activate: false,
        label: expect.stringContaining("glm-5-2"),
      }),
    ]);
    expect(h.createAgentSession).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/## kimi[\s\S]*background tab/);
  });
});
