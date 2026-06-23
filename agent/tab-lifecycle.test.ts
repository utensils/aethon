import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type TabRecord,
} from "./state";
import { SESSION_TITLE_TOOL_NAME } from "./silent-tools";
import {
  buildPickerModels,
  cancelRunningToolCards,
  compilePattern,
  collectPiSlashCommands,
  emitReady,
  emitBashResult,
  extractToolContent,
  handleSessionEvent,
  inferToolResultLanguage,
  ensurePickerHasModel,
  modelDescriptor,
  modelKey,
  refreshCachedModels,
  refreshPiSlashCommands,
  installAethonRetryClassifier,
  resolveTabCwd,
  summarizeToolArgs,
  synthesizeCancelledSubagentToolResults,
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
    responseMessageSeq: 0,
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

describe("ensurePickerHasModel", () => {
  it("patches dynamically added picker models with reasoning and Fast metadata", () => {
    const { state, deps, sent } = makeFixture();
    const model = {
      provider: "openai-codex",
      id: "gpt-5.5",
      name: "GPT-5.5 Codex",
      reasoning: true,
    };

    ensurePickerHasModel(state, deps, model as never);

    expect(sent).toContainEqual({
      type: "state_patch",
      path: "/sidebar/models",
      value: [
        expect.objectContaining({
          id: "openai-codex/gpt-5.5",
          label: "GPT-5.5 Codex",
          thinkingLevels: expect.arrayContaining(["medium"]),
          codexFastModeSupported: true,
        }),
      ],
    });
  });
});

describe("buildPickerModels", () => {
  it("filters by enabledModels and keeps the active model visible", () => {
    const { state } = makeFixture();
    const claude = {
      id: "claude-sonnet-4-5",
      provider: "anthropic",
      name: "Claude Sonnet",
    };
    const codex = {
      id: "gpt-5.1-codex",
      provider: "openai-codex",
      name: "Codex",
    };
    const llama = { id: "llama3", provider: "ollama", name: "Llama" };
    state.modelRegistry = {
      getAll: () => [claude, codex, llama],
      getAvailable: () => [claude, codex, llama],
    } as unknown as AethonAgentState["modelRegistry"];
    state.settingsManager = {
      getEnabledModels: () => ["openai-codex/*"],
    } as unknown as AethonAgentState["settingsManager"];

    expect(buildPickerModels(state, claude as never).map(modelKey)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai-codex/gpt-5.1-codex",
    ]);
  });

  it("includes models available through auth profile registries", () => {
    const { state } = makeFixture();
    const codex = {
      id: "gpt-5.5",
      provider: "openai-codex",
      name: "GPT-5.5 Codex",
    };
    state.modelRegistry = {
      getAll: () => [],
      getAvailable: () => [],
    } as unknown as AethonAgentState["modelRegistry"];
    state.authProfileServices.set("codex-work", {
      authStorage: { reload: vi.fn() },
      modelRegistry: {
        getAll: () => [codex],
        getAvailable: () => [codex],
      },
    });
    state.settingsManager = {
      getEnabledModels: () => [],
    } as unknown as AethonAgentState["settingsManager"];

    expect(buildPickerModels(state).map(modelKey)).toEqual([
      "openai-codex/gpt-5.5",
    ]);
  });
});

describe("refreshCachedModels", () => {
  it("reloads settings and registry before rebuilding the picker cache", async () => {
    const { state } = makeFixture();
    const current = {
      id: "old",
      provider: "ollama",
      name: "Old active",
    };
    const refreshed = {
      id: "new",
      provider: "ollama",
      name: "New available",
    };
    let registryModels = [current];
    const reload = vi.fn(async () => {});
    const refresh = vi.fn(() => {
      registryModels = [refreshed];
    });
    state.tabs.set("default", fakeRec("ollama/old"));
    state.cachedModels = [
      { id: "stale/model", label: "Stale", provider: "stale" },
    ];
    state.modelRegistry = {
      getAll: () => registryModels,
      getAvailable: () => registryModels,
      refresh,
    } as unknown as AethonAgentState["modelRegistry"];
    state.settingsManager = {
      getEnabledModels: () => ["ollama/*"],
      reload,
    } as unknown as AethonAgentState["settingsManager"];

    await refreshCachedModels(state);

    expect(reload).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(state.cachedModels.map((model) => model.id)).toEqual([
      "ollama/old",
      "ollama/new",
    ]);
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

  it("summarizes Aethon and pi subagent tools without raw JSON", () => {
    expect(
      summarizeToolArgs("task", {
        subagent_type: "coder",
        prompt: "Fix the UI\nwith details",
      }),
    ).toBe("coder · Fix the UI");
    expect(
      summarizeToolArgs("subagent", {
        agent: "reviewer",
        task: "Review the patch",
      }),
    ).toBe("reviewer · Review the patch");
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
      // Running is derived from `startedAt` (set) + `endedAt`
      // (omitted) on the frontend — no explicit flag in the wire
      // payload.
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

  it("renders task text results as subagent prose output", () => {
    const payload = toolCardPayload({
      id: "tool-c1",
      toolName: "task",
      argsSummary: "coder · fix it",
      result: "Done.",
    });
    const root = payload.components[0] as { children: unknown[] };
    const child = root.children[0] as {
      type: string;
      props: { content: string };
    };
    expect(child.type).toBe("subagent-result");
    expect(child.props.content).toBe("Done.");
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

  it("adds file-change metadata for edit tools", () => {
    const payload = toolCardPayload({
      id: "tool-c1",
      toolName: "edit",
      argsSummary: "src/App.tsx",
      args: { path: "src/App.tsx" },
      rootPath: "/repo",
      result: "--- a/src/App.tsx\n+++ b/src/App.tsx\n-old\n+new",
    });

    expect(payload).toMatchObject({
      components: [
        {
          props: {
            fileChange: {
              kind: "edited",
              path: "src/App.tsx",
              rootPath: "/repo",
              preview: expect.stringContaining("+new"),
              additions: 1,
              deletions: 1,
            },
          },
        },
      ],
    });
  });

  it("classifies write tools as created when the result says a file was created", () => {
    const payload = toolCardPayload({
      id: "tool-c1",
      toolName: "write",
      argsSummary: "src/new.ts",
      args: { path: "src/new.ts" },
      result: "Created file src/new.ts\n+export const ok = true;",
    });

    expect(payload).toMatchObject({
      components: [
        {
          props: {
            fileChange: {
              kind: "created",
              path: "src/new.ts",
              additions: 1,
            },
          },
        },
      ],
    });
  });

  it("keeps malformed edit args on the generic output path", () => {
    const payload = toolCardPayload({
      id: "tool-c1",
      toolName: "edit",
      argsSummary: "",
      args: {},
      result: "edited",
    });

    const root = payload.components[0] as {
      props: Record<string, unknown>;
      children: unknown[];
    };
    expect(root.props.fileChange).toBeUndefined();
    expect(root.children[0]).toMatchObject({ type: "code" });
  });

  it("marks cancelled cards as a terminal state", () => {
    const payload = toolCardPayload({
      id: "tool-c1",
      toolName: "bash",
      argsSummary: "sleep 60",
      result: "Cancelled by user.",
      status: "cancelled",
      startedAt: 1_000,
      endedAt: 2_500,
    });

    expect(payload).toMatchObject({
      components: [
        {
          id: "tool-c1",
          props: {
            status: "cancelled",
            startedAt: 1_000,
            endedAt: 2_500,
          },
        },
      ],
    });
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

describe("resolveTabCwd", () => {
  const base = {
    tabProjectCwds: new Map<string, string>(),
    currentProjectCwd: undefined as string | undefined,
    userDir: "/home/u/.aethon",
  };

  it("cwdOverride wins even when the bridge has another active project", () => {
    // Regression: a tab_open carrying its own cwd must never adopt the
    // bridge's currentProjectCwd (e.g. tab_open racing ahead of
    // set_project, or a tab opened into a background workspace).
    const state = {
      ...base,
      tabProjectCwds: new Map([["t1", "/projects/stale"]]),
      currentProjectCwd: "/projects/other-project",
    };
    expect(resolveTabCwd("t1", { cwdOverride: "/projects/mine" }, state)).toBe(
      "/projects/mine",
    );
  });

  it("a tab's recorded cwd outranks the active project's cwd", () => {
    // Two tabs in different workspaces sharing one bridge: tab A's
    // sessions stay scoped to A's cwd after the user activates B.
    const state = {
      ...base,
      tabProjectCwds: new Map([
        ["tab-a", "/projects/aethon"],
        ["tab-b", "/projects/aethon-feature-wt"],
      ]),
      currentProjectCwd: "/projects/aethon-feature-wt",
    };
    expect(resolveTabCwd("tab-a", {}, state)).toBe("/projects/aethon");
    expect(resolveTabCwd("tab-b", {}, state)).toBe(
      "/projects/aethon-feature-wt",
    );
  });

  it("falls back to the active project cwd, then the user dir", () => {
    expect(
      resolveTabCwd(
        "fresh-tab",
        {},
        { ...base, currentProjectCwd: "/projects/active" },
      ),
    ).toBe("/projects/active");
    expect(resolveTabCwd("fresh-tab", {}, base)).toBe("/home/u/.aethon");
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

  it("surfaces auto-compaction progress as an inline busy notice", () => {
    const f = makeFixture();
    const rec = fakeRec();

    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "auto_compaction_start",
    });

    expect(f.sent[0]).toEqual({
      type: "notice",
      tabId: "tab-1",
      busy: true,
      message: "Compacting context...",
    });
  });

  it("surfaces completed compaction as a timeline notice with token count", () => {
    const f = makeFixture();
    const rec = fakeRec();

    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "auto_compaction_end",
      tokensBefore: 13_005,
    });

    expect(f.sent[0]).toEqual({
      type: "notice",
      tabId: "tab-1",
      message: "Context compacted · 13,005 tokens summarized",
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
      messageId: expect.stringMatching(/^text-\d+-1$/),
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
      messageId: expect.stringMatching(/^text-\d+-1$/),
      channel: "thinking",
    });
  });

  it("agent_end emits missing final text when streaming only delivered thinking", async () => {
    const f = makeFixture();
    const rec = fakeRec();
    const sessionEvents: unknown[] = [];
    f.state.sessionEventHandlers.set(
      "messageUpdated",
      new Set([(payload) => sessionEvents.push(payload)]),
    );
    rec.promptInFlight = true;

    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "checking",
        messageId: "assistant-final",
      },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "checking" },
            { type: "text", text: "No. The PR did not add a rake task." },
          ],
        },
      ],
    });

    expect(f.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "response_delta",
          tabId: "tab-1",
          messageId: "text-assistant-final-1",
          channel: "text",
          content: "No. The PR did not add a rake task.",
        }),
      ]),
    );
    const responseEndIndex = f.sent.findIndex((m) => m.type === "response_end");
    const finalTextIndex = f.sent.findIndex(
      (m) => m.type === "response_delta" && m.channel === "text",
    );
    expect(finalTextIndex).toBeGreaterThan(-1);
    expect(finalTextIndex).toBeLessThan(responseEndIndex);
    await Promise.resolve();
    expect(sessionEvents).toEqual([
      expect.objectContaining({
        sessionId: "tab-1",
        message: expect.objectContaining({
          role: "agent",
          content: "No. The PR did not add a rake task.",
        }),
      }),
    ]);
  });

  it("agent_end only emits the unstreamed suffix of final text", () => {
    const f = makeFixture();
    const rec = fakeRec();

    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Done",
        messageId: "assistant-final",
      },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Done." }],
        },
      ],
    });

    const textDeltas = f.sent.filter(
      (m) => m.type === "response_delta" && m.channel === "text",
    );
    expect(textDeltas.map((m) => m.content)).toEqual(["Done", "."]);
  });

  it("rolls streamed assistant message ids at tool boundaries", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "before" },
      message: { timestamp: 1111 },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "a.ts" },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "after" },
      // Regression: pi can report the previous tool/result timestamp here.
      // The second delta must still allocate a new id so it renders after
      // the tool card rather than amending the earlier bubble in place.
      message: { timestamp: 1111 },
    });

    const deltas = f.sent.filter((m) => m.type === "response_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0].messageId).toEqual(expect.stringMatching(/^text-\d+-1$/));
    expect(deltas[1].messageId).toEqual(expect.stringMatching(/^text-\d+-2$/));
    expect(deltas[1].messageId).not.toBe(deltas[0].messageId);
  });

  it("uses canonical assistant message ids as segment id source when available", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "hello",
        messageId: "a0468d98",
      },
      message: { timestamp: 1234 },
    });
    expect(f.sent[0]).toMatchObject({
      type: "response_delta",
      messageId: "text-a0468d98-1",
    });
  });

  it("does not reuse canonical assistant ids across tool boundaries", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "before",
        messageId: "assistant-1",
      },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "a.ts" },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "after",
        messageId: "assistant-1",
      },
    });

    const deltas = f.sent.filter((m) => m.type === "response_delta");
    expect(deltas.map((m) => m.messageId)).toEqual([
      "text-assistant-1-1",
      "text-assistant-1-2",
    ]);
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

  it("keeps session-title tool calls silent in the live transcript", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Starting" },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_start",
      toolCallId: "c-title",
      toolName: SESSION_TITLE_TOOL_NAME,
      args: { title: "Prompt polish" },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_end",
      toolCallId: "c-title",
      toolName: SESSION_TITLE_TOOL_NAME,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " now." },
    });

    expect(f.sent.some((m) => m.type === "a2ui")).toBe(false);
    expect(f.sent.some((m) => m.type === "terminal_output")).toBe(false);
    const deltas = f.sent.filter((m) => m.type === "response_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[1].messageId).toBe(deltas[0].messageId);
  });

  it("tool_execution_update streams task partials into the existing card", () => {
    const f = makeFixture();
    const rec = fakeRec();
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "task",
      args: { subagent_type: "coder", prompt: "fix the bug" },
    });
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "task",
      args: { subagent_type: "coder", prompt: "fix the bug" },
      partialResult: { content: [{ type: "text", text: "working" }] },
    });

    const a2uiMessages = f.sent.filter((m) => m.type === "a2ui");
    expect(a2uiMessages.map((m) => m.id)).toEqual(["tool-1-c1", "tool-1-c1"]);
    expect(a2uiMessages.at(-1)).toMatchObject({
      payload: {
        components: [
          {
            id: "tool-1-c1",
            props: {
              toolName: "task",
              description: "coder · fix the bug",
              startedAt: expect.any(Number),
            },
            children: [
              {
                type: "subagent-result",
                props: { content: "working" },
              },
            ],
          },
        ],
      },
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

  it("cancelRunningToolCards freezes active tool-card timers", () => {
    const f = makeFixture();
    const rec = fakeRec();
    rec.toolArgsCache.set("c1", {
      name: "bash",
      summary: "sleep 60",
      uiId: "tool-1-c1",
      startedAt: 1_000,
    });

    const count = cancelRunningToolCards(f.deps, rec, "tab-1");

    expect(count).toBe(1);
    expect(rec.toolArgsCache.get("c1")).toMatchObject({
      status: "cancelled",
      endedAt: expect.any(Number),
    });
    const a2uiMsg = f.sent.find((m) => m.type === "a2ui");
    expect(a2uiMsg).toMatchObject({
      id: "tool-1-c1",
      payload: {
        components: [
          {
            id: "tool-1-c1",
            props: {
              status: "cancelled",
              startedAt: 1_000,
              endedAt: expect.any(Number),
            },
          },
        ],
      },
    });
    expect(f.sent.find((m) => m.type === "terminal_output")).toMatchObject({
      content: "\r\n[command cancelled]\r\n",
    });
  });

  it("tool_execution_end updates a cancelled synthetic card by id", () => {
    const f = makeFixture();
    const rec = fakeRec();
    rec.toolArgsCache.set("c1", {
      name: "bash",
      summary: "sleep 60",
      uiId: "tool-1-c1",
      startedAt: 1_000,
    });
    cancelRunningToolCards(f.deps, rec, "tab-1");
    const endedAt = rec.toolArgsCache.get("c1")?.endedAt;

    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: "Command aborted",
      isError: true,
    });

    const a2uiMessages = f.sent.filter((m) => m.type === "a2ui");
    expect(a2uiMessages.map((m) => m.id)).toEqual(["tool-1-c1", "tool-1-c1"]);
    expect(a2uiMessages.at(-1)).toMatchObject({
      payload: {
        components: [
          {
            props: {
              status: "cancelled",
              isError: true,
              endedAt,
            },
          },
        ],
      },
    });
    expect(rec.toolArgsCache.has("c1")).toBe(false);
  });

  it("synthesizes model-visible errors for cancelled subagent delegations", () => {
    const f = makeFixture();
    const rec = fakeRec();
    const messages: unknown[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_batch_1",
            name: "task_batch",
            arguments: { tasks: [] },
          },
        ],
      },
    ];
    const appendMessage = vi.fn();
    rec.session = {
      ...rec.session,
      agent: { state: { messages } },
      sessionManager: {
        appendMessage,
        getEntries: () => [],
      },
    } as TabRecord["session"];
    rec.toolArgsCache.set("call_batch_1", {
      name: "task_batch",
      summary: "3 agents",
      uiId: "tool-1-call_batch_1",
      startedAt: 1_000,
      endedAt: 2_000,
      status: "cancelled",
      taskPartialText: "## qwen\npartial progress",
    });

    const count = synthesizeCancelledSubagentToolResults(f.state, rec, "tab-1");

    expect(count).toBe(1);
    expect(messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call_batch_1",
      toolName: "task_batch",
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("Partial output before interruption"),
        },
      ],
    });
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call_batch_1",
        isError: true,
      }),
    );
    expect(synthesizeCancelledSubagentToolResults(f.state, rec, "tab-1")).toBe(
      0,
    );
  });

  it("does not raw-append duplicates when the session manager already has the synthetic result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aethon-tab-lifecycle-"));
    const sessionsDir = join(dir, "sessions");
    const tabDir = join(sessionsDir, "tab-1");
    const sessionFile = join(tabDir, "session.jsonl");
    await mkdir(tabDir, { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-1", cwd: "/repo" }),
        JSON.stringify({
          type: "message",
          id: "existing-tool-result",
          message: {
            role: "toolResult",
            toolCallId: "call_batch_1",
            toolName: "task_batch",
            content: [{ type: "text", text: "already synthesized" }],
            isError: true,
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const f = makeFixture({ sessionsDir });
    f.state.tabProjectCwds.set("tab-1", "/repo");
    const rec = fakeRec();
    const appendMessage = vi.fn();
    rec.session = {
      ...rec.session,
      agent: { state: { messages: [] } },
      sessionManager: {
        appendMessage,
        getEntries: () => [
          {
            message: {
              role: "toolResult",
              toolCallId: "call_batch_1",
            },
          },
        ],
      },
    } as TabRecord["session"];
    rec.toolArgsCache.set("call_batch_1", {
      name: "task_batch",
      summary: "3 agents",
      uiId: "tool-1-call_batch_1",
      startedAt: 1_000,
      endedAt: 2_000,
      status: "cancelled",
    });

    expect(synthesizeCancelledSubagentToolResults(f.state, rec, "tab-1")).toBe(
      1,
    );
    await Promise.resolve();

    expect(appendMessage).not.toHaveBeenCalled();
    const raw = await readFile(sessionFile, "utf8");
    expect(raw.trim().split(/\r?\n/)).toHaveLength(2);
    expect(raw).not.toContain("aethon-synthetic-tool-result");
  });

  it("does not synthesize model-visible errors for cancelled bash tools", () => {
    const f = makeFixture();
    const rec = fakeRec();
    const messages: unknown[] = [];
    rec.session = {
      ...rec.session,
      agent: { state: { messages } },
    } as TabRecord["session"];
    rec.toolArgsCache.set("call_bash_1", {
      name: "bash",
      summary: "sleep 60",
      uiId: "tool-1-call_bash_1",
      startedAt: 1_000,
      endedAt: 2_000,
      status: "cancelled",
    });

    expect(synthesizeCancelledSubagentToolResults(f.state, rec, "tab-1")).toBe(
      0,
    );
    expect(messages).toEqual([]);
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

  it("agent_end during auto-retry keeps the turn in-flight and suppresses the transient error", () => {
    const f = makeFixture();
    const rec = fakeRec();
    rec.promptInFlight = true;
    rec.session = {
      ...rec.session,
      isRetrying: true,
    } as TabRecord["session"];
    f.state.currentAgentTabId = "tab-1";

    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "WebSocket closed 1006 Connection ended",
        },
      ],
    });

    expect(rec.promptInFlight).toBe(true);
    expect(rec.agentEndFired).toBe(false);
    expect(f.state.currentAgentTabId).toBe("tab-1");
    expect(f.sent.some((m) => m.type === "error")).toBe(false);
    expect(f.sent.some((m) => m.type === "response_end")).toBe(false);
  });

  it("agent_end starts an Aethon retry when the SDK reports a retryable failure without auto-retry", async () => {
    vi.useFakeTimers();
    try {
      const f = makeFixture();
      const rec = fakeRec();
      const continueRun = vi.fn(() => Promise.resolve());
      const failure = {
        role: "assistant",
        stopReason: "error",
        errorMessage: "WebSocket closed 1006 Connection ended",
      };
      rec.promptInFlight = true;
      rec.session = {
        ...rec.session,
        agent: {
          state: { messages: [{ role: "user" }, failure] },
          continue: continueRun,
        },
        settingsManager: {
          getRetrySettings: () => ({
            enabled: true,
            maxRetries: 3,
            baseDelayMs: 2_000,
          }),
        },
      } as TabRecord["session"];
      f.state.currentAgentTabId = "tab-1";

      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "agent_end",
        messages: [failure],
      });

      expect(rec.promptInFlight).toBe(true);
      expect(rec.agentEndFired).toBe(false);
      expect(rec.aethonRetryInFlight).toBe(true);
      expect(
        (rec.session as never as { agent: { state: { messages: unknown[] } } })
          .agent.state.messages,
      ).toEqual([{ role: "user" }]);
      expect(f.state.currentAgentTabId).toBe("tab-1");
      expect(f.sent).toContainEqual({
        type: "notice",
        tabId: "tab-1",
        busy: true,
        message: "Transient provider error; retrying 1/3 in 2s.",
      });
      expect(f.sent.some((m) => m.type === "error")).toBe(false);
      expect(f.sent.some((m) => m.type === "response_end")).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(continueRun).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("agent_end for Codex context overflow keeps the turn open, compacts, and resumes", async () => {
    vi.useFakeTimers();
    try {
      const f = makeFixture();
      const rec = fakeRec("openai-codex/gpt-5.5");
      const failure = {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          'Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}',
      };
      const compact = vi.fn(() => Promise.resolve({ tokensBefore: 159_747 }));
      const agent = {
        state: { messages: [{ role: "user" }, failure] },
        resumed: false,
        continue: vi.fn(function (this: { resumed: boolean }) {
          this.resumed = true;
          return Promise.resolve();
        }),
      };
      rec.promptInFlight = true;
      rec.session = {
        ...rec.session,
        compact,
        agent,
      } as TabRecord["session"];
      f.state.tabs.set("tab-1", rec);
      f.state.currentAgentTabId = "tab-1";

      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "agent_end",
        messages: [failure],
      });

      expect(rec.promptInFlight).toBe(true);
      expect(rec.agentEndFired).toBe(false);
      expect(f.state.currentAgentTabId).toBe("tab-1");
      expect(f.sent).toContainEqual({
        type: "notice",
        tabId: "tab-1",
        busy: true,
        message:
          "Context window exceeded. Compacting context and resuming automatically.",
      });
      expect(f.sent.some((m) => m.type === "error")).toBe(false);
      expect(f.sent.some((m) => m.type === "response_end")).toBe(false);
      expect(
        (rec.session as never as { agent: { state: { messages: unknown[] } } })
          .agent.state.messages,
      ).toEqual([{ role: "user" }, failure]);

      await vi.advanceTimersByTimeAsync(250);

      expect(compact).toHaveBeenCalledOnce();
      expect(agent.continue).toHaveBeenCalledOnce();
      expect(agent.resumed).toBe(true);
      expect(
        (rec.session as never as { agent: { state: { messages: unknown[] } } })
          .agent.state.messages,
      ).toEqual([{ role: "user" }]);
      expect(f.sent.some((m) => m.type === "response_end")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-compacts after a completed turn when live output crossed the threshold", async () => {
    const f = makeFixture();
    f.state.settingsManager = {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens: 200,
        keepRecentTokens: 100,
      }),
    } as unknown as AethonAgentState["settingsManager"];
    const compact = vi.fn(() => Promise.resolve({ tokensBefore: 1_850 }));
    const rec = fakeRec("anthropic/claude-x");
    rec.promptInFlight = true;
    rec.contextUsageTransientTokens = 150;
    rec.session = {
      ...rec.session,
      model: {
        id: "claude-x",
        provider: "anthropic",
        name: "Claude X",
        contextWindow: 2_000,
      },
      getContextUsage: () => ({
        tokens: 1_700,
        contextWindow: 2_000,
        percent: 85,
      }),
      compact,
    } as unknown as TabRecord["session"];
    f.state.tabs.set("tab-1", rec);
    f.state.currentAgentTabId = "tab-1";

    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });

    expect(compact).toHaveBeenCalledOnce();
    expect(rec.promptInFlight).toBe(true);
    expect(f.sent).toContainEqual({
      type: "notice",
      tabId: "tab-1",
      busy: true,
      message: "Context threshold reached; compacting before the next turn...",
    });
    expect(f.sent.some((m) => m.type === "response_end")).toBe(false);

    await vi.waitFor(() => {
      expect(f.sent.some((m) => m.type === "response_end")).toBe(true);
    });
    expect(rec.promptInFlight).toBe(false);
    expect(rec.contextUsageTransientTokens).toBe(0);
  });

  it("resumes after overflow compaction when pi does not mark willRetry", async () => {
    vi.useFakeTimers();
    try {
      const f = makeFixture();
      const rec = fakeRec("openai-codex/gpt-5.5");
      const failure = {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          'Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}',
      };
      const compact = vi.fn(() => Promise.resolve({ tokensBefore: 159_747 }));
      const agent = {
        state: { messages: [{ role: "user" }, failure] },
        resumed: false,
        continue: vi.fn(function (this: { resumed: boolean }) {
          this.resumed = true;
          return Promise.resolve();
        }),
      };
      rec.promptInFlight = true;
      rec.session = {
        ...rec.session,
        compact,
        agent,
      } as TabRecord["session"];
      f.state.tabs.set("tab-1", rec);

      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "agent_end",
        messages: [failure],
      });
      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "compaction_start",
        reason: "overflow",
      });
      expect(
        (rec.session as never as { agent: { state: { messages: unknown[] } } })
          .agent.state.messages,
      ).toEqual([{ role: "user" }, failure]);
      await vi.advanceTimersByTimeAsync(250);
      expect(compact).not.toHaveBeenCalled();

      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "compaction_end",
        reason: "overflow",
        result: { tokensBefore: 159_747 },
        willRetry: false,
      });
      await Promise.resolve();

      expect(agent.continue).toHaveBeenCalledOnce();
      expect(agent.resumed).toBe(true);
      expect(f.sent.some((m) => m.type === "response_end")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes after native overflow compaction events that omit a result", async () => {
    vi.useFakeTimers();
    try {
      const f = makeFixture();
      const rec = fakeRec("openai-codex/gpt-5.5");
      const failure = {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          'Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}',
      };
      const compact = vi.fn(() => Promise.resolve({ tokensBefore: 159_747 }));
      const continueRun = vi.fn(() => Promise.resolve());
      rec.promptInFlight = true;
      rec.session = {
        ...rec.session,
        compact,
        agent: {
          state: { messages: [{ role: "user" }, failure] },
          continue: continueRun,
        },
      } as TabRecord["session"];
      f.state.tabs.set("tab-1", rec);

      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "agent_end",
        messages: [failure],
      });
      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "auto_compaction_start",
        reason: "overflow",
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(compact).not.toHaveBeenCalled();

      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "auto_compaction_end",
        reason: "overflow",
        willRetry: false,
      });
      await Promise.resolve();

      expect(continueRun).toHaveBeenCalledOnce();
      expect(f.sent).toContainEqual({
        type: "notice",
        tabId: "tab-1",
        message: "Context compacted",
      });
      expect(f.sent.some((m) => m.type === "error")).toBe(false);
      expect(f.sent.some((m) => m.type === "response_end")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume after overflow compaction is aborted", async () => {
    vi.useFakeTimers();
    try {
      const f = makeFixture();
      const rec = fakeRec("openai-codex/gpt-5.5");
      const failure = {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          'Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}',
      };
      const compact = vi.fn(() => Promise.resolve({ tokensBefore: 159_747 }));
      const continueRun = vi.fn(() => Promise.resolve());
      rec.promptInFlight = true;
      rec.session = {
        ...rec.session,
        compact,
        agent: {
          state: { messages: [{ role: "user" }, failure] },
          continue: continueRun,
        },
      } as TabRecord["session"];
      f.state.tabs.set("tab-1", rec);

      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "agent_end",
        messages: [failure],
      });
      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "compaction_start",
        reason: "overflow",
      });
      handleSessionEvent(f.state, f.deps, rec, "tab-1", {
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        aborted: true,
        willRetry: false,
      });
      await Promise.resolve();

      expect(compact).not.toHaveBeenCalled();
      expect(continueRun).not.toHaveBeenCalled();
      expect(f.sent).toContainEqual({
        type: "notice",
        tabId: "tab-1",
        message: "Context compaction cancelled.",
      });
      expect(f.sent).toContainEqual({
        type: "error",
        tabId: "tab-1",
        message: "Context overflow recovery cancelled during compaction.",
      });
      expect(f.sent).toContainEqual({ type: "response_end", tabId: "tab-1" });
      expect(
        f.sent.some(
          (m) => m.type === "notice" && m.message === "Context compacted",
        ),
      ).toBe(false);
      expect(rec.promptInFlight).toBe(false);
      await vi.advanceTimersByTimeAsync(250);
      expect(compact).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("agent_end during auto-retry surfaces non-retryable failures and ends the turn", () => {
    const f = makeFixture();
    const rec = fakeRec();
    rec.promptInFlight = true;
    rec.session = {
      ...rec.session,
      isRetrying: true,
    } as TabRecord["session"];
    f.state.currentAgentTabId = "tab-1";

    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage:
            "Authentication failed for openai-codex. Run /login openai-codex.",
        },
      ],
    });

    expect(f.sent[0]).toMatchObject({
      type: "error",
      tabId: "tab-1",
      message:
        "Authentication failed for openai-codex. Run /login openai-codex.",
    });
    expect(f.sent[1]).toMatchObject({ type: "response_end", tabId: "tab-1" });
    expect(rec.promptInFlight).toBe(false);
    expect(rec.agentEndFired).toBe(true);
    expect(f.state.currentAgentTabId).toBeUndefined();
  });

  it("auto_retry_start keeps the tab busy and tells the frontend a retry is underway", () => {
    const f = makeFixture();
    const rec = fakeRec();

    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "WebSocket closed 1006 Connection ended",
    });

    expect(rec.promptInFlight).toBe(true);
    expect(rec.agentEndFired).toBe(false);
    expect(f.state.currentAgentTabId).toBe("tab-1");
    expect(f.sent[0]).toMatchObject({
      type: "notice",
      tabId: "tab-1",
      busy: true,
      message: "Transient provider error; retrying 1/3 in 2s.",
    });
  });

  it("auto_retry_end with !success emits an error message", () => {
    const f = makeFixture();
    const rec = fakeRec();
    rec.promptInFlight = true;
    f.state.currentAgentTabId = "tab-1";
    handleSessionEvent(f.state, f.deps, rec, "tab-1", {
      type: "auto_retry_end",
      success: false,
      finalError: "rate limit",
    });
    expect(f.sent[0]).toMatchObject({
      type: "error",
      message: "auto-retry exhausted: rate limit",
    });
    expect(f.sent[1]).toMatchObject({ type: "response_end", tabId: "tab-1" });
    expect(rec.promptInFlight).toBe(false);
    expect(rec.agentEndFired).toBe(true);
    expect(f.state.currentAgentTabId).toBeUndefined();
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

  it("extends pi's retry classifier for websocket 1006 transport drops", () => {
    const session = {
      _isRetryableError: (message: { errorMessage?: string }) =>
        message.errorMessage === "upstream retryable",
    };
    installAethonRetryClassifier(session);

    expect(
      session._isRetryableError({
        stopReason: "error",
        errorMessage: "upstream retryable",
      }),
    ).toBe(true);
    expect(
      session._isRetryableError({
        stopReason: "error",
        errorMessage: "WebSocket closed 1006 Connection ended",
      }),
    ).toBe(true);
    expect(
      session._isRetryableError({
        stopReason: "error",
        errorMessage: "Your credit balance is too low",
      }),
    ).toBe(false);
  });
});
