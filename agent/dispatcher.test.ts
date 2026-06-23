import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type ProjectBaselineSnapshot,
  type TabRecord,
} from "./state";
import { handleA2UIEvent } from "./a2uiEvents";
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
import { emitSessionEvent } from "./aethon-api-sessions";
import { handleSetExtensionDisabled } from "./extensionControl";
import { projectDisplayName } from "./projectLifecycle";

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
      thinkingLevel: "medium",
      getAvailableThinkingLevels: () => [],
    } as unknown as TabRecord["session"],
    toolArgsCache: new Map(),
    promptInFlight: false,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
    responseMessageSeq: 0,
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
  it("refreshes persisted session discovery before report ready payloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-report-"));
    const previousWorkerTabId = process.env.AETHON_WORKER_TAB_ID;
    delete process.env.AETHON_WORKER_TAB_ID;
    try {
      const sessionsDir = join(root, "sessions");
      const tabDir = join(sessionsDir, "tab-new");
      mkdirSync(tabDir, { recursive: true });
      writeFileSync(
        join(tabDir, "1.jsonl"),
        `${JSON.stringify({ type: "session", id: "s", cwd: "/repo/workspace" })}\n${JSON.stringify(
          {
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "restore this workspace" }],
            },
          },
        )}\n`,
      );
      const f = makeFixture({
        userDir: root,
        stateFile: join(root, "state.json"),
        sessionsDir,
      });
      f.state.discoveredTabs = [];

      await dispatchInboundMessage(
        f.state,
        f.deps,
        fakeAethonApi(),
        fakeExtensionApi,
        { type: "report" },
      );

      expect(f.sent.find((m) => m.type === "ready")).toMatchObject({
        discoveredTabs: [
          {
            tabId: "tab-new",
            cwd: "/repo/workspace",
            firstUserMessage: "restore this workspace",
          },
        ],
      });
    } finally {
      if (previousWorkerTabId === undefined) {
        delete process.env.AETHON_WORKER_TAB_ID;
      } else {
        process.env.AETHON_WORKER_TAB_ID = previousWorkerTabId;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("cancels pending context usage emits when closing a tab", async () => {
    vi.useFakeTimers();
    try {
      const f = makeFixture();
      const delayedSend = vi.fn(() => {
        f.sent.push({ type: "context_usage", tabId: "tab-1" });
      });
      const tab = fakeTabRecord({
        contextUsageEmitTimer: setTimeout(delayedSend, 100),
      });
      f.state.tabs.set("tab-1", tab);

      await dispatchInboundMessage(
        f.state,
        f.deps,
        fakeAethonApi(),
        fakeExtensionApi,
        {
          type: "tab_close",
          tabId: "tab-1",
        },
      );
      vi.advanceTimersByTime(100);

      expect(delayedSend).not.toHaveBeenCalled();
      expect(tab.contextUsageEmitTimer).toBeUndefined();
      expect(f.state.tabs.has("tab-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats native compact results as timeline markers", async () => {
    const f = makeFixture();
    f.state.tabs.set(
      "tab-1",
      fakeTabRecord({
        session: {
          compact: vi.fn(() => Promise.resolve({ tokensBefore: 159_747 })),
        } as unknown as TabRecord["session"],
      }),
    );

    await dispatchInboundMessage(
      f.state,
      f.deps,
      fakeAethonApi(),
      fakeExtensionApi,
      {
        type: "native_slash_command",
        name: "compact",
        tabId: "tab-1",
      },
    );

    expect(f.sent).toContainEqual({
      type: "native_slash_result",
      tabId: "tab-1",
      command: "compact",
      message: "Context compacted · 159,747 tokens summarized",
    });
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

describe("handleA2UIEvent", () => {
  it("drains a pending reload after a handler-started prompt ends", async () => {
    const f = makeFixture();
    let resolvePrompt: (() => void) | undefined;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      return undefined as never;
    }) satisfies typeof process.exit);
    const tab = fakeTabRecord({
      session: {
        prompt: () =>
          new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          }),
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);
    f.state.a2uiEventHandlers.push({
      match: { componentType: "button", eventType: "click" },
      handler: (_ev, ctx) => ctx.pi.prompt("from handler"),
    });

    await handleA2UIEvent(f.state, f.deps, fakeAethonApi(), {
      type: "a2ui_event",
      tabId: "tab-1",
      event: { componentType: "button", eventType: "click" },
    });

    await vi.waitFor(() => {
      expect(tab.promptInFlight).toBe(true);
      expect(f.sent).toContainEqual({
        type: "prompt_started",
        tabId: "tab-1",
        source: "handler",
      });
    });
    f.state.reloadPending = true;
    resolvePrompt?.();

    await vi.waitFor(() => {
      expect(tab.promptInFlight).toBe(false);
      expect(f.sent).toContainEqual({ type: "_reload_done" });
      expect(exit).toHaveBeenCalledWith(0);
    });
    exit.mockRestore();
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
    // A queued message must NOT announce a fresh turn start — the
    // queue-drained agent_start emits prompt_started later instead.
    expect(f.sent.some((m) => m.type === "prompt_started")).toBe(false);
  });

  it("announces prompt_started for a normal turn so backgrounded workspaces show a running dot", async () => {
    const f = makeFixture();
    const tab = fakeTabRecord({
      session: {
        prompt: () => Promise.resolve(),
        followUp: () => Promise.resolve(),
        steer: () => Promise.resolve(),
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "do the thing",
      tabId: "tab-1",
      mode: "normal",
    });

    // prompt_started populates the frontend's bucket-independent running set,
    // which is the only "running" signal for a non-active workspace — without
    // it a backgrounded agent shows no activity dot until you select its tab.
    expect(f.sent).toContainEqual({
      type: "prompt_started",
      tabId: "tab-1",
      source: "chat",
    });
    // ...and the turn still closes with the matching response_end.
    await vi.waitFor(() =>
      expect(f.sent).toContainEqual({ type: "response_end", tabId: "tab-1" }),
    );
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

  it("adds plan-mode instructions to normal prompts and records the tab mode", async () => {
    const f = makeFixture();
    const promptCalls: unknown[][] = [];
    const tab = fakeTabRecord({
      session: {
        prompt: (...args: unknown[]) => {
          promptCalls.push(args);
          return Promise.resolve();
        },
        followUp: () => Promise.resolve(),
        steer: () => Promise.resolve(),
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "design the fix",
      tabId: "tab-1",
      mode: "normal",
      planMode: true,
    });

    expect(f.state.tabPlanMode.get("tab-1")).toBe(true);
    expect(promptCalls[0][0]).toContain("Aethon plan mode");
    expect(promptCalls[0][0]).toContain("User request:\ndesign the fix");
  });

  it("adds plan-mode instructions to steering prompts", async () => {
    const f = makeFixture();
    const steerCalls: unknown[][] = [];
    const tab = fakeTabRecord({
      promptInFlight: true,
      session: {
        prompt: () => Promise.resolve(),
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
      content: "adjust the plan",
      tabId: "tab-1",
      mode: "steer",
      planMode: true,
    });

    expect(steerCalls[0][0]).toContain("Aethon plan mode");
    expect(steerCalls[0][0]).toContain("User request:\nadjust the plan");
  });

  it("steers retry-active sessions even when Aethon's in-flight flag is stale", async () => {
    const f = makeFixture();
    const promptCalls: unknown[][] = [];
    const steerCalls: unknown[][] = [];
    const tab = fakeTabRecord({
      promptInFlight: false,
      session: {
        isStreaming: true,
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
      content: "status update?",
      tabId: "tab-1",
      mode: "steer",
    });

    expect(tab.promptInFlight).toBe(true);
    expect(promptCalls).toEqual([]);
    expect(steerCalls).toEqual([["status update?"]]);
    expect(f.sent).not.toContainEqual({ type: "queued", tabId: "tab-1" });
  });

  it("queues normal sends for retry-active sessions when Aethon's in-flight flag is stale", async () => {
    const f = makeFixture();
    const promptCalls: unknown[][] = [];
    const followUpCalls: unknown[][] = [];
    const tab = fakeTabRecord({
      promptInFlight: false,
      session: {
        isStreaming: true,
        prompt: (...args: unknown[]) => {
          promptCalls.push(args);
          return Promise.resolve();
        },
        followUp: (...args: unknown[]) => {
          followUpCalls.push(args);
          return Promise.resolve();
        },
        steer: () => Promise.resolve(),
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "update?",
      tabId: "tab-1",
      mode: "normal",
    });

    expect(tab.promptInFlight).toBe(true);
    expect(tab.queuedCount).toBe(1);
    expect(promptCalls).toEqual([]);
    expect(followUpCalls).toEqual([["update?"]]);
    expect(f.sent).toContainEqual({ type: "queued", tabId: "tab-1" });
  });

  it("does not emit hidden scheduler prompts as direct user events", async () => {
    const f = makeFixture();
    const events: unknown[] = [];
    f.state.tabs.set("tab-1", fakeTabRecord());
    f.state.sessionEventHandlers.set(
      "messageAppended",
      new Set([(payload) => events.push(payload)]),
    );

    await handleChat(f.state, f.deps, {
      type: "chat",
      content:
        "This is an Aethon scheduled task run.\n\nUser request:\nvisible",
      tabId: "tab-1",
      mode: "normal",
      scheduledTaskId: "task-1",
      scheduledRunId: "run-1",
      scheduledVisiblePrompt: "visible",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([]);
  });

  it("does not re-append already streamed assistant messages from local persistence", async () => {
    const f = makeFixture({
      sessionsDir: mkdtempSync(join(tmpdir(), "aethon-local-")),
    });
    const events: unknown[] = [];
    emitSessionEvent(f.state, "messageUpdated", {
      sessionId: "tab-1",
      messageId: "agent-1",
      message: { id: "agent-1", role: "agent", content: "hi", text: "hi" },
    });
    f.state.sessionEventHandlers.set(
      "messageAppended",
      new Set([(payload) => events.push(payload)]),
    );

    await dispatchInboundMessage(
      f.state,
      f.deps,
      fakeAethonApi(),
      fakeExtensionApi,
      {
        type: "local_chat_message",
        tabId: "tab-1",
        payload: { id: "agent-1", role: "agent", text: "hi!" },
      },
    );

    expect(events).toEqual([]);
  });

  it("emits session user events for direct chat unless frontend already mirrored it", async () => {
    const f = makeFixture();
    const events: unknown[] = [];
    const tab = fakeTabRecord({
      session: {
        prompt: () => new Promise<void>(() => {}),
        followUp: () => Promise.resolve(),
        steer: () => Promise.resolve(),
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);
    f.state.sessionEventHandlers.set(
      "messageAppended",
      new Set([(payload) => events.push(payload)]),
    );

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "direct prompt",
      tabId: "tab-1",
      mode: "normal",
      planMode: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: "tab-1",
        message: expect.objectContaining({
          role: "user",
          content: "direct prompt",
        }),
      }),
    ]);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "frontend prompt",
      tabId: "tab-1",
      mode: "normal",
      suppressUserSessionEvent: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toHaveLength(1);
  });

  it("passes image attachments to prompt, steer, and followUp", async () => {
    const image = { mimeType: "image/png", data: "abc123" };
    const f = makeFixture();
    const calls: Record<string, unknown[][]> = {
      prompt: [],
      steer: [],
      followUp: [],
    };
    const tab = fakeTabRecord({
      session: {
        prompt: (...args: unknown[]) => {
          calls.prompt.push(args);
          return new Promise<void>(() => {});
        },
        followUp: (...args: unknown[]) => {
          calls.followUp.push(args);
          return Promise.resolve();
        },
        steer: (...args: unknown[]) => {
          calls.steer.push(args);
          return Promise.resolve();
        },
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "look",
      tabId: "tab-1",
      mode: "normal",
      images: [image],
    });

    expect(calls.prompt).toEqual([
      [
        "look",
        { images: [{ type: "image", mimeType: "image/png", data: "abc123" }] },
      ],
    ]);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "zoom",
      tabId: "tab-1",
      mode: "steer",
      images: [image],
    });
    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "next",
      tabId: "tab-1",
      mode: "normal",
      images: [image],
    });

    expect(calls.steer).toEqual([
      ["zoom", [{ type: "image", mimeType: "image/png", data: "abc123" }]],
    ]);
    expect(calls.followUp).toEqual([
      ["next", [{ type: "image", mimeType: "image/png", data: "abc123" }]],
    ]);
  });

  it("keeps the turn busy if the SDK is still streaming when prompt() settles", async () => {
    const f = makeFixture();
    let resolvePrompt: (() => void) | undefined;
    const session = {
      isStreaming: false,
      prompt: () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        }),
      followUp: () => Promise.resolve(),
      steer: () => Promise.resolve(),
    };
    const tab = fakeTabRecord({
      session: session as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "start",
      tabId: "tab-1",
      mode: "normal",
    });
    session.isStreaming = true;
    resolvePrompt?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(tab.promptInFlight).toBe(true);
    expect(f.sent).not.toContainEqual({ type: "response_end", tabId: "tab-1" });
  });

  it("dispatches prompts containing unresolved dotted @mentions instead of failing file-reference expansion", async () => {
    const f = makeFixture();
    const promptCalls: unknown[][] = [];
    const tab = fakeTabRecord({
      session: {
        prompt: (...args: unknown[]) => {
          promptCalls.push(args);
          return new Promise<void>(() => {});
        },
        followUp: () => Promise.resolve(),
        steer: () => Promise.resolve(),
      } as unknown as TabRecord["session"],
    });
    f.state.tabs.set("tab-1", tab);

    await handleChat(f.state, f.deps, {
      type: "chat",
      content: "Allow the @search_result.resolved_bbl.blank? guard to continue",
      tabId: "tab-1",
      mode: "normal",
    });

    expect(promptCalls).toEqual([
      ["Allow the @search_result.resolved_bbl.blank? guard to continue"],
    ]);
    expect(f.sent).toContainEqual({
      type: "notice",
      tabId: "tab-1",
      message:
        "file references: @search_result.resolved_bbl.blank? was not found under " +
        process.cwd(),
    });
    expect(f.sent).not.toContainEqual(
      expect.objectContaining({ type: "error", tabId: "tab-1" }),
    );
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
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        type: "model_changed",
        tabId: "tab-1",
        model: "openai/gpt-5.5",
      }),
    );
  });

  it("preserves non-Codex colon tags that resemble reasoning suffixes", async () => {
    const f = makeFixture();
    const nextModel = {
      provider: "ollama",
      id: "foo:high",
      name: "Foo high tag",
    };
    const find = vi.fn(() => nextModel);
    const setModel = vi.fn(() => Promise.resolve());
    f.state.modelRegistry = {
      find,
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
          setModel,
        } as unknown as TabRecord["session"],
      }),
    );

    await handleSetModel(f.state, f.deps, {
      type: "set_model",
      id: "ollama/foo:high",
      tabId: "tab-1",
    });

    expect(find).toHaveBeenCalledWith("ollama", "foo:high");
    expect(setModel).toHaveBeenCalledWith(nextModel);
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

describe("handleSetExtensionDisabled", () => {
  it("emits the best-known source for extension-package toggles", async () => {
    const f = makeFixture();
    f.state.disabledExtensions.add("pkg-ext");
    f.state.disabledExtensionMeta.set("pkg-ext", {
      source: "extension-package",
    });

    await handleSetExtensionDisabled(f.state, f.deps, f.deps, {
      type: "set_extension_disabled",
      name: "pkg-ext",
      disabled: false,
    });

    expect(f.sent).toContainEqual({
      type: "extension_lifecycle",
      name: "pkg-ext",
      source: "extension-package",
      status: "enabled",
    });
  });
});

describe("projectDisplayName", () => {
  it("handles POSIX, Windows, mixed, and trailing separators", () => {
    expect(projectDisplayName("/Users/me/project/")).toBe("project");
    expect(projectDisplayName("C:\\Users\\me\\project")).toBe("project");
    expect(projectDisplayName("C:\\Users/me\\project\\")).toBe("project");
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
      code: "extension.registerComponent('base', () => null)",
    });
    f.state.extensionHighlightGrammars.set("base-lang", {
      lang: "base-lang",
      grammar: { scopeName: "source.base" },
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
      code: "extension.registerComponent('project', () => null)",
    });
    f.state.extensionHighlightGrammars.set("project-lang", {
      lang: "project-lang",
      grammar: { scopeName: "source.project" },
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
    expect([...f.state.extensionHighlightGrammars.keys()]).toEqual([
      "base-lang",
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
    expect(types).toContain("extension_highlight_grammars");
    const frontendModulesMsg = f.sent.find(
      (m) => m.type === "extension_frontend_modules",
    );
    expect(frontendModulesMsg).toMatchObject({
      modules: [{ name: "base-module" }],
    });
    const grammarsMsg = f.sent.find(
      (m) => m.type === "extension_highlight_grammars",
    );
    expect(grammarsMsg).toMatchObject({
      grammars: [{ lang: "base-lang" }],
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
      highlightGrammars: new Map(),
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
