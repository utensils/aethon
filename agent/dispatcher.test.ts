import { describe, expect, it, vi } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type ProjectBaselineSnapshot,
  type TabRecord,
} from "./state";
import {
  captureProjectExtensionBaseline,
  dispatchInboundMessage,
  exportTargetForSlashCommand,
  formatContextUsageMessage,
  formatSessionStatsMessage,
  handleChat,
  handleSetModel,
  handleStop,
  unloadProjectExtensions,
} from "./dispatcher";

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

function makeFixture() {
  const state = new AethonAgentState(baseOpts);
  const sent: Record<string, unknown>[] = [];
  let writes = 0;
  return {
    state,
    sent,
    deps: {
      send: (m: Record<string, unknown>) => sent.push(m),
      scheduleStateFileWrite: () => {
        writes += 1;
      },
      loadHooks: {},
    },
    writes: () => writes,
  };
}

function fakeTabRecord(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    session: {
      prompt: () => Promise.resolve(),
      steer: () => Promise.resolve(),
      followUp: () => Promise.resolve(),
    } as unknown as TabRecord["session"],
    toolArgsCache: new Map(),
    promptInFlight: false,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
    ...overrides,
  };
}

function fakeAethonApi(overrides: Record<string, unknown> = {}) {
  return {
    registerComponent: vi.fn(),
    setState: vi.fn(),
    setLayout: vi.fn(),
    patchLayout: vi.fn(),
    registerTheme: vi.fn(),
    shells: {},
    ...overrides,
  } as unknown as Parameters<typeof dispatchInboundMessage>[2];
}

const fakeExtensionApi = {} as Parameters<typeof dispatchInboundMessage>[3];

describe("dispatchInboundMessage", () => {
  it("keeps bridge API commands in the router shell", async () => {
    const f = makeFixture();
    const api = fakeAethonApi();
    const payload = { type: "card" };

    await dispatchInboundMessage(f.state, f.deps, api, fakeExtensionApi, {
      type: "register_component",
      componentType: "demo-card",
      template: payload,
    });

    expect(api.registerComponent).toHaveBeenCalledWith("demo-card", payload);
    expect(f.sent).toEqual([]);
  });

  it("persists frontend state patches without crossing command modules", async () => {
    const f = makeFixture();

    await dispatchInboundMessage(
      f.state,
      f.deps,
      fakeAethonApi(),
      fakeExtensionApi,
      {
        type: "frontend_state_patch",
        path: "/tabs",
        value: [{ id: "tab-1" }],
      },
    );

    expect(f.state.frontendState.get("/tabs")).toEqual([{ id: "tab-1" }]);
    expect(f.writes()).toBe(1);
  });

  it("contains handler failures and reports them as bridge errors", async () => {
    const f = makeFixture();
    const api = fakeAethonApi({
      setLayout: () => {
        throw new Error("layout registry offline");
      },
    });

    await dispatchInboundMessage(f.state, f.deps, api, fakeExtensionApi, {
      type: "set_layout",
      payload: { components: [] },
    });

    expect(f.sent).toContainEqual({
      type: "error",
      message: "layout registry offline",
    });
  });
});

describe("handleStop", () => {
  it("aborts bash and emits a terminal tool-card update for active tools", async () => {
    const f = makeFixture();
    const abort = vi.fn(() => Promise.resolve());
    const abortBash = vi.fn();
    const clearQueue = vi.fn();
    const tab = fakeTabRecord({
      queuedCount: 3,
      session: {
        abort,
        abortBash,
        clearQueue,
      } as unknown as TabRecord["session"],
      toolArgsCache: new Map([
        [
          "call-1",
          {
            name: "bash",
            summary: "sleep 60",
            uiId: "tool-1-call-1",
            startedAt: 1_000,
          },
        ],
      ]),
    });
    f.state.tabs.set("tab-1", tab);

    handleStop(f.state, f.deps, { type: "stop", tabId: "tab-1" });
    await Promise.resolve();

    expect(clearQueue).toHaveBeenCalledOnce();
    expect(abortBash).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(tab.queuedCount).toBe(0);
    expect(f.sent).toContainEqual({ type: "queue_reset", tabId: "tab-1" });
    expect(f.sent.find((m) => m.type === "a2ui")).toMatchObject({
      id: "tool-1-call-1",
      payload: {
        components: [
          {
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
});

describe("handleChat", () => {
  it("queues normal messages while a prompt is in flight", async () => {
    const f = makeFixture();
    const promptCalls: unknown[][] = [];
    const followUpCalls: unknown[][] = [];
    const steerCalls: unknown[][] = [];
    const tab = fakeTabRecord({
      promptInFlight: true,
      session: {
        prompt: (...args: unknown[]) => {
          promptCalls.push(args);
          return Promise.resolve();
        },
        followUp: (...args: unknown[]) => {
          followUpCalls.push(args);
          return Promise.resolve();
        },
        steer: (...args: unknown[]) => {
          steerCalls.push(args);
          return Promise.resolve();
        },
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "after this",
      tabId: "tab-1",
      mode: "normal",
    });

    expect(tab.queuedCount).toBe(1);
    expect(promptCalls).toEqual([]);
    expect(followUpCalls).toEqual([["after this"]]);
    expect(steerCalls).toEqual([]);
    expect(f.sent).toContainEqual({ type: "queued", tabId: "tab-1" });
  });

  it("rolls back the queue count when followUp rejects", async () => {
    const f = makeFixture();
    const tab = fakeTabRecord({
      promptInFlight: true,
      queuedCount: 2,
      session: {
        prompt: () => Promise.resolve(),
        followUp: () => Promise.reject(new Error("queue offline")),
        steer: () => Promise.resolve(),
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "after this",
      tabId: "tab-1",
      mode: "normal",
    });

    expect(f.sent).toContainEqual({ type: "queued", tabId: "tab-1" });
    await vi.waitFor(() => {
      expect(tab.queuedCount).toBe(2);
      expect(f.sent).toContainEqual({
        type: "queue_reset",
        tabId: "tab-1",
        queued: 2,
      });
      expect(f.sent).toContainEqual({
        type: "error",
        tabId: "tab-1",
        message: "followUp: queue offline",
      });
    });
  });

  it("steers command-enter messages into the active prompt", async () => {
    const f = makeFixture();
    const promptCalls: unknown[][] = [];
    const steerCalls: unknown[][] = [];
    const tab = fakeTabRecord({
      promptInFlight: true,
      queuedCount: 2,
      session: {
        prompt: (...args: unknown[]) => {
          promptCalls.push(args);
          return Promise.resolve();
        },
        followUp: () => Promise.resolve(),
        steer: (...args: unknown[]) => {
          steerCalls.push(args);
          return Promise.resolve();
        },
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "look here now",
      tabId: "tab-1",
      mode: "steer",
    });

    expect(tab.queuedCount).toBe(2);
    expect(promptCalls).toEqual([]);
    expect(steerCalls).toEqual([["look here now"]]);
    expect(f.sent).not.toContainEqual({ type: "queued", tabId: "tab-1" });
  });

  it("treats steer as a normal prompt when the tab is idle", async () => {
    const f = makeFixture();
    const promptCalls: unknown[][] = [];
    const steerCalls: unknown[][] = [];
    const pendingPrompt = new Promise<void>(() => {});
    const tab = fakeTabRecord({
      session: {
        prompt: (...args: unknown[]) => {
          promptCalls.push(args);
          return pendingPrompt;
        },
        followUp: () => Promise.resolve(),
        steer: (...args: unknown[]) => {
          steerCalls.push(args);
          return Promise.resolve();
        },
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "start fresh",
      tabId: "tab-1",
      mode: "steer",
    });

    expect(promptCalls).toEqual([["start fresh"]]);
    expect(steerCalls).toEqual([]);
    expect(tab.promptInFlight).toBe(true);
  });

  it("starts an idle tab immediately even while another tab is running", async () => {
    const f = makeFixture();
    const first = fakeTabRecord({ id: "tab-1", promptInFlight: true });
    const promptCalls: unknown[][] = [];
    const second = fakeTabRecord({
      id: "tab-2",
      session: {
        prompt: (...args: unknown[]) => {
          promptCalls.push(args);
          return new Promise<void>(() => {});
        },
        followUp: () => Promise.resolve(),
        steer: () => Promise.resolve(),
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", first);
    f.state.tabs.set("tab-2", second);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "run in parallel",
      tabId: "tab-2",
      mode: "normal",
    });

    expect(first.queuedCount).toBe(0);
    expect(second.queuedCount).toBe(0);
    expect(second.promptInFlight).toBe(true);
    expect(promptCalls).toEqual([["run in parallel"]]);
    expect(f.sent).not.toContainEqual({ type: "queued", tabId: "tab-2" });
  });
});

describe("handleSetModel", () => {
  it("routes missing model ids to the originating tab", async () => {
    const f = makeFixture();

    await handleSetModel(f.state, f.deps, {
      type: "set_model",
      tabId: "tab-1",
    });

    expect(f.sent).toContainEqual({
      type: "error",
      tabId: "tab-1",
      message: "set_model: missing id",
    });
  });

  it("reloads runtime prompt resources after the session model changes", async () => {
    const f = makeFixture();
    const nextModel = {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT 5.5",
    };
    const setModel = vi.fn(() => Promise.resolve());
    const reload = vi.fn(() => Promise.resolve());
    f.state.modelRegistry = {
      find: vi.fn(() => nextModel),
    } as unknown as AethonAgentState["modelRegistry"];
    f.state.resourceLoader = {
      reload,
    } as unknown as AethonAgentState["resourceLoader"];
    f.state.cachedModels = [];
    f.state.tabs.set(
      "tab-1",
      fakeTabRecord({
        session: {
          prompt: () => Promise.resolve(),
          steer: () => Promise.resolve(),
          followUp: () => Promise.resolve(),
          setModel,
        } as unknown as TabRecord["session"],
      }),
    );

    await handleSetModel(f.state, f.deps, {
      type: "set_model",
      id: "openai/gpt-5.5",
      tabId: "tab-1",
    });

    expect(setModel).toHaveBeenCalledWith(nextModel);
    expect(reload).toHaveBeenCalledOnce();
    expect(f.writes()).toBe(1);
    expect(f.sent).toContainEqual({
      type: "model_changed",
      tabId: "tab-1",
      model: "openai/gpt-5.5",
    });
  });

  it("routes model switch failures to the originating tab", async () => {
    const f = makeFixture();
    const nextModel = {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT 5.5",
    };
    f.state.modelRegistry = {
      find: vi.fn(() => nextModel),
    } as unknown as AethonAgentState["modelRegistry"];
    f.state.resourceLoader = {
      reload: vi.fn(() => Promise.resolve()),
    } as unknown as AethonAgentState["resourceLoader"];
    f.state.tabs.set(
      "tab-1",
      fakeTabRecord({
        session: {
          prompt: () => Promise.resolve(),
          steer: () => Promise.resolve(),
          followUp: () => Promise.resolve(),
          setModel: () => Promise.reject(new Error("provider offline")),
        } as unknown as TabRecord["session"],
      }),
    );

    await handleSetModel(f.state, f.deps, {
      type: "set_model",
      id: "openai/gpt-5.5",
      tabId: "tab-1",
    });

    expect(f.writes()).toBe(0);
    expect(f.sent).toContainEqual({
      type: "error",
      tabId: "tab-1",
      message: "set_model: provider offline",
    });
  });
});

describe("captureProjectExtensionBaseline", () => {
  it("snapshots every extension registry independently of the live one", () => {
    const f = makeFixture();
    f.state.extensionComponents.set("a", { type: "card" });
    f.state.extensionThemes.set("t", { id: "t", label: "T", vars: {} });
    f.state.extensionStateTree = { x: 1 };
    f.state.extensionLayout = { components: [] };
    f.state.pendingLayoutPatches = [{ path: "/x", value: 1 }];
    f.state.eventRoutingMode = "extension";

    const snap = captureProjectExtensionBaseline(f.state);
    // Mutate live state — snap must not move.
    f.state.extensionComponents.set("b", { type: "card" });
    f.state.extensionThemes.set("u", { id: "u", label: "U", vars: {} });
    (f.state.extensionStateTree as { x: number }).x = 99;
    f.state.eventRoutingMode = "builtin";

    expect(snap.components.size).toBe(1);
    expect(snap.themes.size).toBe(1);
    expect(snap.stateTree).toEqual({ x: 1 });
    expect(snap.eventRoutingMode).toBe("extension");
    expect(snap.extensionLayout).toEqual({ components: [] });
    expect(snap.pendingLayoutPatches).toEqual([{ path: "/x", value: 1 }]);

    expect(f.state.projectBaseline).toBe(snap);
  });
});

describe("unloadProjectExtensions", () => {
  it("is a no-op when no baseline captured", () => {
    const f = makeFixture();
    unloadProjectExtensions(f.state, f.deps);
    expect(f.sent).toEqual([]);
  });

  it("restores every registry from the baseline and emits hydrate messages", () => {
    const f = makeFixture();
    f.state.extensionComponents.set("base", { type: "card" });
    f.state.extensionStateTree = { base: { ok: true } };
    f.state.extensionStateKeys.add("/base");
    f.state.extensionFrontendModules.set("base-module", {
      name: "base-module",
      entryPath: "/base/frontend.js",
      code: "skill.registerComponent('base', () => null)",
    });
    f.state.eventRoutingMode = "builtin";
    captureProjectExtensionBaseline(f.state);
    // Now layer some "project" registrations on top.
    f.state.extensionComponents.set("project-only", { type: "card" });
    f.state.extensionThemes.set("project-theme", {
      id: "project-theme",
      label: "P",
      vars: {},
    });
    f.state.extensionStateTree = {
      ...f.state.extensionStateTree,
      projectOnly: { stale: true },
    };
    f.state.extensionStateKeys.add("/projectOnly");
    f.state.extensionFrontendModules.set("project-module", {
      name: "project-module",
      entryPath: "/project/frontend.js",
      code: "skill.registerComponent('project', () => null)",
    });
    f.state.eventRoutingMode = "extension";
    f.state.loadedExtensions.set("foo", "project-directory");
    f.state.loadedExtensions.set("base-ext", "directory");

    unloadProjectExtensions(f.state, f.deps);

    // Restored state.
    expect(f.state.extensionComponents.size).toBe(1);
    expect(f.state.extensionComponents.has("project-only")).toBe(false);
    expect(f.state.extensionThemes.size).toBe(0);
    expect(f.state.extensionStateTree).toEqual({ base: { ok: true } });
    expect([...f.state.extensionStateKeys]).toEqual(["/base"]);
    expect([...f.state.extensionFrontendModules.keys()]).toEqual([
      "base-module",
    ]);
    expect(f.state.eventRoutingMode).toBe("builtin");
    // loadedExtensions: project-directory entries dropped, others kept.
    expect(f.state.loadedExtensions.has("foo")).toBe(false);
    expect(f.state.loadedExtensions.has("base-ext")).toBe(true);

    // Hydrate messages emitted in order.
    const types = f.sent.map((m) => m.type);
    expect(types).toContain("extension_components");
    expect(types).toContain("extension_themes");
    expect(types).toContain("extension_slash_commands");
    expect(types).toContain("extension_keybindings");
    expect(types).toContain("extension_menu_items");
    expect(types).toContain("extension_layouts");
    expect(types).toContain("extension_event_routes");
    expect(types).toContain("extension_frontend_modules");
    const frontendModulesMsg = f.sent.find(
      (m) => m.type === "extension_frontend_modules",
    );
    expect(frontendModulesMsg).toMatchObject({
      modules: [{ name: "base-module" }],
    });
    expect(f.writes()).toBe(1);
  });

  it("runs project teardowns and clears the queue", () => {
    const f = makeFixture();
    let teardownsRan = 0;
    f.state.projectExtensionTeardowns.push(() => {
      teardownsRan += 1;
    });
    captureProjectExtensionBaseline(f.state);
    unloadProjectExtensions(f.state, f.deps);
    expect(teardownsRan).toBe(1);
    expect(f.state.projectExtensionTeardowns).toHaveLength(0);
  });

  it("re-emits a layout_set with the boot layout when the project unset its override", () => {
    const f = makeFixture();
    f.state.bootLayout = { components: [{ id: "boot" }] };
    captureProjectExtensionBaseline(f.state);
    f.state.extensionLayout = { components: [{ id: "project" }] };
    unloadProjectExtensions(f.state, f.deps);
    const layoutMsg = f.sent.find((m) => m.type === "layout_set");
    expect(layoutMsg).toMatchObject({
      payload: { components: [{ id: "boot" }] },
    });
  });

  it("keeps the dedupe set and handler array consistent with baseline length", () => {
    const f = makeFixture();
    f.state.a2uiEventHandlers.push({ match: {}, handler: () => {} });
    f.state.registeredHandlerKeys.add("base-key");
    captureProjectExtensionBaseline(f.state);
    f.state.a2uiEventHandlers.push({ match: {}, handler: () => {} });
    f.state.registeredHandlerKeys.add("project-key");
    unloadProjectExtensions(f.state, f.deps);
    expect(f.state.a2uiEventHandlers).toHaveLength(1);
    expect([...f.state.registeredHandlerKeys]).toEqual(["base-key"]);
  });
});

describe("ProjectBaselineSnapshot type shape", () => {
  it("exposes all expected fields", () => {
    // Type-level reassurance — the test compiles iff fields are present.
    const snap: ProjectBaselineSnapshot = {
      components: new Map(),
      themes: new Map(),
      slashCommands: new Map(),
      keybindings: new Map(),
      menuItems: new Map(),
      layouts: new Map(),
      eventRoutes: new Map(),
      eventRoutingMode: "builtin",
      eventHandlerCount: 0,
      handlerDedupeKeys: [],
      stateTree: {},
      stateKeys: [],
      frontendModules: new Map(),
      extensionLayout: undefined,
      pendingLayoutPatches: [],
    };
    expect(snap.eventRoutingMode).toBe("builtin");
  });
});

describe("native slash command formatters", () => {
  it("formats context usage with remaining tokens", () => {
    expect(
      formatContextUsageMessage(
        { tokens: 12_000, contextWindow: 200_000, percent: 6 },
        "anthropic/claude",
      ),
    ).toContain("- Remaining: 188,000 tokens");
  });

  it("formats unknown context usage after compaction", () => {
    expect(
      formatContextUsageMessage(
        { tokens: null, contextWindow: 200_000, percent: null },
        "anthropic/claude",
      ),
    ).toContain("- Used: unknown");
  });

  it("formats session stats", () => {
    const message = formatSessionStatsMessage(
      {
        sessionFile: "/tmp/session.jsonl",
        sessionId: "abc",
        userMessages: 2,
        assistantMessages: 3,
        toolCalls: 4,
        toolResults: 5,
        totalMessages: 10,
        tokens: {
          input: 1000,
          output: 2000,
          cacheRead: 0,
          cacheWrite: 0,
          total: 3000,
        },
        cost: 0.0123,
      },
      "Work",
    );
    expect(message).toContain("- Name: Work");
    expect(message).toContain("- Total: $0.0123");
  });
});

describe("exportTargetForSlashCommand", () => {
  it("clamps user-supplied export names under the aethon exports directory", () => {
    const f = makeFixture();
    expect(
      exportTargetForSlashCommand(f.state, "../../etc/passwd.html"),
    ).toEqual({
      path: "/tmp/aethon-test/exports/passwd.html",
      jsonl: false,
    });
  });

  it("only treats a real .jsonl extension as jsonl export", () => {
    const f = makeFixture();
    expect(exportTargetForSlashCommand(f.state, "session.jsonl")).toEqual({
      path: "/tmp/aethon-test/exports/session.jsonl",
      jsonl: true,
    });
    expect(exportTargetForSlashCommand(f.state, "session.jsonl.bak")).toEqual({
      path: "/tmp/aethon-test/exports/session.jsonl.bak.html",
      jsonl: false,
    });
  });
});
