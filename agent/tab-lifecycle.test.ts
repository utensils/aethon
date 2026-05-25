import { describe, expect, it } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type TabRecord,
} from "./state";
import {
  compilePattern,
  collectPiSlashCommands,
  emitReady,
  emitBashResult,
  extractToolContent,
  handleSessionEvent,
  inferToolResultLanguage,
  modelDescriptor,
  modelKey,
  refreshPiSlashCommands,
  summarizeToolArgs,
  tabSessionDir,
  toolCardPayload,
} from "./tab-lifecycle";

const baseOpts: AethonAgentStateOptions = {
  userDir: "/tmp/aethon-test",
  stateFile: "/tmp/aethon-test/state.json",
  sessionsDir: "/tmp/aethon-test/sessions",
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

function makeFixture(opts: Partial<AethonAgentStateOptions> = {}) {
  const state = new AethonAgentState({ ...baseOpts, ...opts });
  const sent: Record<string, unknown>[] = [];
  return {
    state,
    sent,
    deps: { send: (m: Record<string, unknown>) => sent.push(m) },
  };
}

function fakeRec(model = "anthropic/claude-x"): TabRecord {
  const [provider, ...rest] = model.split("/");
  return {
    id: "t",
    session: {
      model: { id: rest.join("/"), provider, name: "Claude X" },
      messages: [],
    } as unknown as TabRecord["session"],
    toolArgsCache: new Map(),
    promptInFlight: false,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
  };
}

describe("modelKey + modelDescriptor", () => {
  it("composes provider/id and exposes label", () => {
    const m = { id: "claude-haiku-4-5", provider: "anthropic", name: "Haiku" };
    expect(modelKey(m as never)).toBe("anthropic/claude-haiku-4-5");
    expect(modelDescriptor(m as never)).toEqual({
      id: "anthropic/claude-haiku-4-5",
      label: "Haiku",
      provider: "anthropic",
    });
  });
});

describe("compilePattern", () => {
  it("treats * as a wildcard but escapes other regex chars", () => {
    const p = compilePattern("anthropic/claude-*");
    expect(p.test("anthropic/claude-haiku")).toBe(true);
    // Match exactly the pattern shape — "claude-" requires a hyphen.
    expect(p.test("anthropic/claude-")).toBe(true);
    expect(p.test("anthropic/gpt-4o")).toBe(false);
    // Slash isn't matched by * (excluded in the rewrite to [^/]*).
    expect(p.test("anthropic/claude-x/y")).toBe(false);
  });
});

describe("summarizeToolArgs", () => {
  it("summarizes known tools concisely", () => {
    expect(
      summarizeToolArgs("read", { path: "x.ts", startLine: 1, endLine: 9 }),
    ).toBe("x.ts lines 1-9");
    expect(summarizeToolArgs("bash", { command: "echo hi\nbye" })).toBe(
      "echo hi",
    );
    expect(summarizeToolArgs("write", { path: "x.ts" })).toBe("x.ts");
    expect(summarizeToolArgs("grep", { pattern: "foo", path: "src" })).toBe(
      "foo in src",
    );
    expect(summarizeToolArgs("ls", {})).toBe(".");
  });

  it("falls back to JSON for unknown tools, truncated near 200 chars", () => {
    const result = summarizeToolArgs("unknown", { x: "a".repeat(300) });
    // Implementation slices to 197 then appends "…", so total = 198.
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns empty for non-objects", () => {
    expect(summarizeToolArgs("read", null)).toBe("");
    expect(summarizeToolArgs("read", "x")).toBe("");
  });
});

describe("extractToolContent", () => {
  it("returns string-style results unchanged", () => {
    expect(extractToolContent("hi")).toEqual({ text: "hi", images: [] });
  });

  it("walks content[] to pull text + image entries", () => {
    expect(
      extractToolContent({
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
      }),
    ).toEqual({
      text: "hello",
      images: [{ data: "abc", mimeType: "image/png" }],
    });
  });

  it("caps images at MAX_IMAGES_PER_RESULT (4)", () => {
    const content = Array.from({ length: 8 }, (_, i) => ({
      type: "image",
      data: `d${i}`,
      mimeType: "image/png",
    }));
    expect(extractToolContent({ content }).images).toHaveLength(4);
  });

  it("falls back to JSON for objects without content/text", () => {
    expect(extractToolContent({ x: 1 })).toEqual({
      text: '{\n  "x": 1\n}',
      images: [],
    });
  });
});

describe("toolCardPayload", () => {
  it("renders a running card with title + description", () => {
    const payload = toolCardPayload({
      id: "tool-c1",
      toolName: "bash",
      argsSummary: "echo hi",
      running: true,
      startedAt: 12345,
    });
    expect(payload).toMatchObject({
      components: [
        {
          id: "tool-c1",
          type: "tool-card",
          props: {
            title: "bash",
            toolName: "bash",
            description: "echo hi",
            startedAt: 12345,
          },
        },
      ],
    });
  });

  it("appends a code child for text results, with a 1500 char cap", () => {
    const result = "x".repeat(2000);
    const payload = toolCardPayload({
      id: "tool-c1",
      toolName: "read",
      argsSummary: "",
      result,
    });
    const root = payload.components[0] as { children: unknown[] };
    const code = root.children[0] as {
      type: string;
      props: { content: string };
    };
    expect(code.type).toBe("code");
    expect(code.props.content.length).toBe(1500);
    expect(code.props.content.endsWith("…")).toBe(true);
  });

  it("infers the code language for file-backed tool results", () => {
    const payload = toolCardPayload({
      id: "tool-c1",
      toolName: "read",
      argsSummary: "src/App.tsx lines 1-end",
      result: "export function App() { return null; }",
    });
    const root = payload.components[0] as { children: unknown[] };
    const code = root.children[0] as { props: { language: string } };
    expect(code.props.language).toBe("tsx");
  });

  it("appends image children with data: URLs", () => {
    const payload = toolCardPayload({
      id: "tool-c1",
      toolName: "screenshot",
      argsSummary: "",
      result: {
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      },
    });
    const root = payload.components[0] as { children: unknown[] };
    const image = root.children[0] as { type: string; props: { src: string } };
    expect(image.type).toBe("image");
    expect(image.props.src).toBe("data:image/png;base64,abc");
  });
});

describe("inferToolResultLanguage", () => {
  it("uses read/edit/write paths when available", () => {
    expect(inferToolResultLanguage("read", "flake.nix", "{ }")).toBe("nix");
    expect(
      inferToolResultLanguage("write", "src/main.rs", "fn main() {}"),
    ).toBe("rust");
  });

  it("detects json and diffs for non-file-backed output", () => {
    expect(inferToolResultLanguage("bash", "", '{ "ok": true }')).toBe("json");
    expect(inferToolResultLanguage("bash", "", "diff --git a/x b/x")).toBe(
      "diff",
    );
  });
});

describe("tabSessionDir", () => {
  it("uses safe ids unchanged and replaces unsafe ones", () => {
    const f = makeFixture();
    expect(tabSessionDir(f.state, "abc-123")).toMatch(/abc-123$/);
    expect(tabSessionDir(f.state, "../etc/passwd")).toMatch(/_unsafe$/);
  });
});

describe("emitReady", () => {
  it("includes project root and per-tab cwd so the frontend can keep cwd scoped", () => {
    const f = makeFixture({ projectRoot: "/repo/aethon" });
    const rec = fakeRec("anthropic/claude-x");
    rec.id = "tab-1";
    f.state.currentProjectCwd = "/repo/a";
    f.state.tabs.set("tab-1", rec);
    f.state.tabProjectCwds.set("tab-1", "/repo/a");

    emitReady(f.state, f.deps);

    expect(f.sent[0]).toMatchObject({
      type: "ready",
      projectRoot: "/repo/aethon",
      currentProjectCwd: "/repo/a",
      tabs: [
        {
          id: "tab-1",
          model: "anthropic/claude-x",
          cwd: "/repo/a",
        },
      ],
    });
  });
});

describe("collectPiSlashCommands", () => {
  it("collects extension commands, prompt templates, and skill commands", () => {
    const f = makeFixture();
    f.state.resourceLoader = {
      getSkills: () => ({
        skills: [
          {
            name: "review",
            description: "Review code",
            sourceInfo: { scope: "user" },
          },
        ],
        diagnostics: [],
      }),
    } as never;
    const session = {
      promptTemplates: [
        {
          name: "commit",
          description: "Draft commit message",
          sourceInfo: { scope: "project" },
        },
      ],
      _extensionRunner: {
        getRegisteredCommands: () => [
          {
            invocationName: "todos",
            description: "Manage todos",
            sourceInfo: { scope: "user" },
          },
          {
            invocationName: "review:1",
            description: "Review duplicate",
            sourceInfo: { scope: "user" },
          },
        ],
      },
    } as unknown as TabRecord["session"];

    expect(collectPiSlashCommands(f.state, session)).toEqual([
      {
        name: "todos",
        description: "Manage todos",
        source: "extension",
        sourceInfo: { scope: "user" },
      },
      {
        name: "review:1",
        description: "Review duplicate",
        source: "extension",
        sourceInfo: { scope: "user" },
      },
      {
        name: "commit",
        description: "Draft commit message",
        source: "prompt",
        sourceInfo: { scope: "project" },
      },
      {
        name: "skill:review",
        description: "Review code",
        source: "skill",
        sourceInfo: { scope: "user" },
      },
    ]);
  });

  it("refreshes the state snapshot and legacy skill subset", () => {
    const f = makeFixture();
    f.state.resourceLoader = {
      getSkills: () => ({
        skills: [{ name: "plan", description: "Plan work" }],
        diagnostics: [],
      }),
    } as never;
    const session = { promptTemplates: [] } as unknown as TabRecord["session"];
    refreshPiSlashCommands(f.state, session);
    expect(f.state.piSlashCommands).toEqual([
      { name: "skill:plan", description: "Plan work", source: "skill" },
    ]);
    expect(f.state.piSkills).toEqual([
      { name: "skill:plan", description: "Plan work" },
    ]);
  });
});

describe("emitBashResult", () => {
  it("normalizes \\n → \\r\\n and chunks at TERMINAL_CHUNK_BYTES", () => {
    const f = makeFixture();
    const text = "a\nb\nc";
    emitBashResult(f.deps, text, "tab-1");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      type: "terminal_output",
      tabId: "tab-1",
      content: "a\r\nb\r\nc",
    });
  });

  it("truncates to last TERMINAL_MAX_BYTES with a [truncated] header", () => {
    const f = makeFixture();
    // 70 KB of content > 64 KB cap.
    const text = "x".repeat(70 * 1024);
    emitBashResult(f.deps, text, "tab-1");
    expect(f.sent[0]).toMatchObject({
      type: "terminal_output",
      content: expect.stringContaining("output truncated"),
    });
    // Body output follows.
    expect(f.sent.length).toBeGreaterThanOrEqual(2);
  });

  it("no-op on empty input", () => {
    const f = makeFixture();
    emitBashResult(f.deps, "", "tab-1");
    expect(f.sent).toHaveLength(0);
  });
});

describe("handleSessionEvent", () => {
  it("agent_start sets currentAgentTabId and records turnStartTimes", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", { type: "agent_start" });
    expect(f.state.currentAgentTabId).toBe("tab-1");
    expect(f.state.turnStartTimes.has("tab-1")).toBe(true);
  });

  it("agent_start emits prompt_started with queue source when queuedCount > 0", () => {
    const f = makeFixture();
    const rec = fakeRec();
    rec.queuedCount = 2;
    handleSessionEvent(f.state, f.deps, rec, "tab-1", { type: "agent_start" });
    expect(rec.queuedCount).toBe(1);
    expect(rec.promptInFlight).toBe(true);
    expect(f.sent.find((m) => m.type === "prompt_started")).toMatchObject({
      source: "queue",
      queued: 1,
    });
  });

  it("message_update with text_delta emits response_delta", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
      message: { timestamp: 1234 },
    });
    expect(f.sent[0]).toMatchObject({
      type: "response_delta",
      tabId: "tab-1",
      content: "hello",
      messageId: "text-1234",
      channel: "text",
    });
  });

  it("message_update with thinking_delta emits response_delta on thinking channel", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "plan" },
      message: { timestamp: 1234 },
    });
    expect(f.sent[0]).toMatchObject({
      type: "response_delta",
      tabId: "tab-1",
      content: "plan",
      messageId: "text-1234",
      channel: "thinking",
    });
  });

  it("tool_execution_start emits a2ui card and (for bash) a terminal echo", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(rec.toolArgsCache.has("c1")).toBe(true);
    const a2uiMsg = f.sent.find((m) => m.type === "a2ui");
    expect(a2uiMsg).toMatchObject({ id: "tool-1-c1" });
    expect(f.sent.find((m) => m.type === "terminal_output")).toMatchObject({
      content: "\r\n$ ls\r\n",
    });
  });

  it("keeps repeated SDK tool call ids as distinct chat cards", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "one" },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: "done",
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "two" },
    });

    const ids = f.sent.filter((m) => m.type === "a2ui").map((m) => m.id);
    expect(ids).toEqual(["tool-1-c1", "tool-1-c1", "tool-2-c1"]);
  });

  it("agent_end clears promptInFlight, sets agentEndFired, emits response_end", () => {
    const f = makeFixture();
    const rec = fakeRec();
    rec.promptInFlight = true;
    f.state.currentAgentTabId = "tab-1";
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "end_turn" }],
    });
    expect(rec.promptInFlight).toBe(false);
    expect(rec.agentEndFired).toBe(true);
    expect(f.state.currentAgentTabId).toBeUndefined();
    expect(f.sent.find((m) => m.type === "response_end")).toBeDefined();
  });

  it("auto_retry_end with !success emits an error message", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "auto_retry_end",
      success: false,
      finalError: "rate limit",
    });
    expect(f.sent[0]).toMatchObject({
      type: "error",
      message: "auto-retry exhausted: rate limit",
    });
  });

  it("auto_retry_end with success is a no-op", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "auto_retry_end",
      success: true,
    });
    expect(f.sent).toHaveLength(0);
  });
});
