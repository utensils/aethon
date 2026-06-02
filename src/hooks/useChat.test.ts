// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { makeEmptyTab, type Tab } from "../types/tab";
import { useChat, type UseChatContext } from "./useChat";
import { PI_DEFAULT_MODEL_SENTINEL } from "../utils/modelPicker";

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve(undefined),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

afterEach(() => {
  // Reset both call history AND any per-test implementation override
  // (the live-switch-failure test installs a rejecting impl) so nothing
  // leaks into the next test.
  invoke.mockReset();
  invoke.mockImplementation(() => Promise.resolve(undefined));
});

function buildContext(overrides: Record<string, unknown> = {}): {
  ctx: UseChatContext;
  stateRef: MutableRefObject<Record<string, unknown>>;
  recordProjectModel: ReturnType<typeof vi.fn>;
  piDefaultModelRef: MutableRefObject<string>;
} {
  const tab = {
    ...makeEmptyTab("tab-1", "Tab 1"),
    model: "anthropic/claude-opus-4-7",
    projectId: "project-1",
  };
  const stateRef: MutableRefObject<Record<string, unknown>> = {
    current: {
      activeTabId: "tab-1",
      model: "anthropic/claude-opus-4-7",
      waiting: false,
      sidebar: {
        models: [
          { id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7" },
          { id: "openai/gpt-5.5", label: "GPT-5.5" },
        ],
      },
      tabs: [tab],
      ...overrides,
    },
  };
  const setState: Dispatch<SetStateAction<Record<string, unknown>>> = (arg) => {
    stateRef.current = typeof arg === "function" ? arg(stateRef.current) : arg;
  };
  const updateTab = (tabId: string, mutator: (tab: Tab) => Tab) => {
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = mutator(tabs[idx]);
      tabs[idx] = next;
      return {
        ...prev,
        tabs,
        ...(prev.activeTabId === tabId ? { model: next.model } : {}),
      };
    });
  };
  const recordProjectModel = vi.fn();
  const piDefaultModelRef: MutableRefObject<string> = {
    current: (overrides.piDefaultModel as string | undefined) ?? "",
  };
  return {
    stateRef,
    recordProjectModel,
    piDefaultModelRef,
    ctx: {
      setState,
      stateRef,
      updateTab,
      updateActiveTab: (mutator) =>
        updateTab(stateRef.current.activeTabId as string, mutator),
      pendingTabOpens: { current: new Map() },
      slashCommandsRef: { current: [] },
      pushNotification: vi.fn(),
      slashContext: () =>
        ({
          appendSystem: vi.fn(),
          notify: vi.fn(),
          clearChat: vi.fn(),
          setTheme: vi.fn(),
          setModel: vi.fn(),
        }) as unknown as ReturnType<UseChatContext["slashContext"]>,
      persistLocalChatMessage: vi.fn(),
      recordProjectModel,
      piDefaultModelRef,
    },
  };
}

describe("useChat setModel", () => {
  it("inserts timestamped system messages inline for restored transcripts", () => {
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      messages: [
        { id: "u1", role: "user" as const, text: "hi", createdAt: 1_000 },
        { id: "a1", role: "agent" as const, text: "done", createdAt: 3_000 },
      ],
    };
    const { ctx, stateRef } = buildContext({ tabs: [tab] });
    const { result } = renderHook(() => useChat(ctx));

    act(() => {
      result.current.appendMessage({
        id: "stderr",
        role: "system",
        text: "[agent stderr] warning",
        createdAt: 2_000,
      });
    });

    expect(
      (stateRef.current.tabs as Tab[])[0].messages.map((m) => m.id),
    ).toEqual(["u1", "stderr", "a1"]);
  });

  it("sends normal chat messages with normal mode", async () => {
    const { ctx, stateRef } = buildContext();
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("hello");
    });

    expect(invoke).toHaveBeenCalledWith("send_message", {
      request: {
        message: "hello",
        tabId: "tab-1",
        mode: "normal",
        model: "anthropic/claude-opus-4-7",
      },
    });
    expect((stateRef.current.tabs as Tab[])[0].messages.at(-1)).toMatchObject({
      role: "user",
      text: "hello",
      delivery: "sent",
    });
  });

  it("sends image attachments with the user message and clears draft attachments", async () => {
    const attachment = {
      id: "img-1",
      kind: "image" as const,
      path: "/tmp/aethon-pastes/one.png",
      name: "one.png",
      mimeType: "image/png",
      sizeBytes: 12,
    };
    const { ctx, stateRef } = buildContext();
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("what is this?", {
        attachments: [attachment],
      });
    });

    expect(invoke).toHaveBeenCalledWith("send_message", {
      request: {
        message: "what is this?",
        tabId: "tab-1",
        mode: "normal",
        attachments: [attachment],
        model: "anthropic/claude-opus-4-7",
      },
    });
    const tab = (stateRef.current.tabs as Tab[])[0];
    expect(tab.messages.at(-1)).toMatchObject({
      role: "user",
      text: "what is this?",
      attachments: [attachment],
    });
    expect(tab.draftAttachments).toEqual([]);
  });

  it("can send a programmatic prompt to an explicit non-active tab", async () => {
    const mainTab = { ...makeEmptyTab("main-tab", "Main"), projectId: "p1" };
    const issueTab = {
      ...makeEmptyTab("issue-tab", "Issue #86"),
      projectId: "p1",
      cwd: "/projects/aethon-fix-86",
    };
    const { ctx, stateRef } = buildContext({
      activeTabId: "main-tab",
      status: "ready",
      tabs: [mainTab, issueTab],
    });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("work on issue", { tabId: "issue-tab" });
    });

    expect(invoke).toHaveBeenCalledWith("send_message", {
      request: {
        message: "work on issue",
        tabId: "issue-tab",
        mode: "normal",
        cwd: "/projects/aethon-fix-86",
        model: "anthropic/claude-opus-4-7",
      },
    });
    const tabs = stateRef.current.tabs as Tab[];
    expect(tabs.find((t) => t.id === "main-tab")?.messages).toEqual([]);
    expect(
      tabs.find((t) => t.id === "issue-tab")?.messages.at(-1),
    ).toMatchObject({
      role: "user",
      text: "work on issue",
      delivery: "sent",
    });
    expect(ctx.persistLocalChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        text: "work on issue",
        delivery: "sent",
      }),
      "issue-tab",
    );
    expect(tabs.find((t) => t.id === "issue-tab")?.waiting).toBe(true);
    expect(stateRef.current.status).toBe("ready");
  });

  it("passes explicit non-active slash commands through to the target agent", async () => {
    const run = vi.fn();
    const mainTab = { ...makeEmptyTab("main-tab", "Main"), projectId: "p1" };
    const issueTab = { ...makeEmptyTab("issue-tab", "Issue"), projectId: "p1" };
    const { ctx, stateRef } = buildContext({
      activeTabId: "main-tab",
      tabs: [mainTab, issueTab],
    });
    ctx.slashCommandsRef.current = [
      { name: "clear", description: "Clear chat", run },
    ];
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("/clear", { tabId: "issue-tab" });
    });

    expect(run).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("send_message", {
      request: {
        message: "/clear",
        tabId: "issue-tab",
        mode: "normal",
        model: "anthropic/claude-opus-4-7",
      },
    });
    const tabs = stateRef.current.tabs as Tab[];
    expect(tabs.find((t) => t.id === "main-tab")?.messages).toEqual([]);
    expect(
      tabs.find((t) => t.id === "issue-tab")?.messages.at(-1),
    ).toMatchObject({
      role: "user",
      text: "/clear",
    });
  });

  it("steerQueuedMessage pops the entry, flips the spinner id, and ships it as steer", async () => {
    const { ctx, stateRef } = buildContext({ waiting: true });
    const { result } = renderHook(() => useChat(ctx));

    // Pre-load two queued items.
    await act(async () => {
      await result.current.sendChat("first");
      await result.current.sendChat("second");
    });
    const queued = (stateRef.current.tabs as Tab[])[0].queuedMessages;
    expect(queued.map((m) => m.content)).toEqual(["first", "second"]);

    await act(async () => {
      await result.current.steerQueuedMessage("tab-1", queued[0].id);
    });

    // The steered message is no longer in the queue.
    const finalTab = (stateRef.current.tabs as Tab[])[0];
    expect(finalTab.queuedMessages.map((m) => m.content)).toEqual(["second"]);
    // queuedSteeringId clears after the dispatch settles.
    expect(finalTab.queuedSteeringId).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("send_message", {
      request: {
        message: "first",
        tabId: "tab-1",
        mode: "steer",
        model: "anthropic/claude-opus-4-7",
      },
    });
  });

  it("editQueuedMessage replaces the content of a queued entry in place", async () => {
    const { ctx, stateRef } = buildContext({ waiting: true });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("orig");
    });
    const queued = (stateRef.current.tabs as Tab[])[0].queuedMessages;
    expect(queued).toHaveLength(1);

    act(() => {
      result.current.editQueuedMessage("tab-1", queued[0].id, "rewritten");
    });
    expect((stateRef.current.tabs as Tab[])[0].queuedMessages[0].content).toBe(
      "rewritten",
    );
  });

  it("deleteQueuedMessage removes the entry from the queue", async () => {
    const { ctx, stateRef } = buildContext({ waiting: true });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("drop me");
      await result.current.sendChat("keep me");
    });
    const queued = (stateRef.current.tabs as Tab[])[0].queuedMessages;

    act(() => {
      result.current.deleteQueuedMessage("tab-1", queued[0].id);
    });
    expect(
      (stateRef.current.tabs as Tab[])[0].queuedMessages.map((m) => m.content),
    ).toEqual(["keep me"]);
  });

  it("clearQueuedMessages empties the queue", async () => {
    const { ctx, stateRef } = buildContext({ waiting: true });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("a");
      await result.current.sendChat("b");
      await result.current.sendChat("c");
    });
    expect((stateRef.current.tabs as Tab[])[0].queuedMessages).toHaveLength(3);

    act(() => {
      result.current.clearQueuedMessages("tab-1");
    });
    expect((stateRef.current.tabs as Tab[])[0].queuedMessages).toEqual([]);
    expect((stateRef.current.tabs as Tab[])[0].queueCount).toBe(0);
  });

  it("holds normal messages in the client queue while the active prompt is busy", async () => {
    // Claudette-style: a busy normal-mode send goes to the popover, not
    // to the bridge. The user-bubble only enters history once
    // useQueuedDispatch pops it on idle and re-fires sendChat.
    const { ctx, stateRef } = buildContext({ waiting: true });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("after this");
    });

    expect(invoke).not.toHaveBeenCalledWith(
      "send_message",
      expect.objectContaining({
        request: expect.objectContaining({ message: "after this" }),
      }),
    );
    const tab = (stateRef.current.tabs as Tab[])[0];
    expect(tab.queuedMessages.map((m) => m.content)).toEqual(["after this"]);
    expect(tab.queueCount).toBe(1);
    // No user bubble lands in history while queued — the popover owns
    // the visual representation until drain.
    expect(tab.messages.some((m) => m.text === "after this")).toBe(false);
  });

  it("holds attachments with queued normal messages while the prompt is busy", async () => {
    const attachment = {
      id: "img-queued",
      kind: "image" as const,
      path: "/tmp/aethon-pastes/queued.png",
      name: "queued.png",
      mimeType: "image/png",
      sizeBytes: 10,
    };
    const { ctx, stateRef } = buildContext({ waiting: true });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("after this", {
        attachments: [attachment],
      });
    });

    const tab = (stateRef.current.tabs as Tab[])[0];
    expect(tab.queuedMessages).toEqual([
      expect.objectContaining({
        content: "after this",
        attachments: [attachment],
      }),
    ]);
    expect(tab.draftAttachments).toEqual([]);
  });

  it("stopPrompt empties the client-held queue (regression: P2 from peer review)", async () => {
    // The composer's "Stop + clear" button advertises queue clearing.
    // Without this, queued messages survived the stop and drained on
    // the next idle, executing prompts the user had just tried to
    // cancel.
    const { ctx, stateRef } = buildContext({ waiting: true });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("a");
      await result.current.sendChat("b");
      await result.current.sendChat("c");
    });
    expect((stateRef.current.tabs as Tab[])[0].queuedMessages).toHaveLength(3);

    await act(async () => {
      await result.current.stopPrompt("tab-1");
    });

    const tab = (stateRef.current.tabs as Tab[])[0];
    expect(tab.queuedMessages).toEqual([]);
    expect(tab.queueCount).toBe(0);
    expect(invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({ type: "stop", tabId: "tab-1" }),
    });
  });

  it("stopPrompt reconciles confirmed stops so stale tool cards do not keep spinning", async () => {
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd === "agent_diagnostics") {
        return Promise.resolve([
          {
            key: "tab:tab-1",
            tab_id: "tab-1",
            alive: true,
            prompt_in_flight: false,
          },
        ]);
      }
      return Promise.resolve(undefined);
    });
    const runningTool = {
      id: "tool-message",
      role: "agent" as const,
      a2ui: {
        components: [
          {
            id: "restored-tool-call_1",
            type: "tool-card",
            props: {
              title: "bash",
              description: "curl https://example.test",
              startedAt: 1_000,
            },
            children: [],
          },
        ],
      },
    };
    const { ctx, stateRef } = buildContext({
      status: "thinking…",
      waiting: true,
      tabs: [
        {
          ...makeEmptyTab("tab-1", "Tab 1"),
          waiting: true,
          messages: [runningTool],
        },
      ],
    });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.stopPrompt("tab-1");
    });

    expect(stateRef.current.status).toBe("stopped");
    expect(stateRef.current.waiting).toBe(false);
    const tab = (stateRef.current.tabs as Tab[])[0];
    const toolCard = (tab.messages[0].a2ui?.components ?? [])[0];
    expect(toolCard.props).toMatchObject({
      status: "cancelled",
      endedAt: expect.any(Number),
    });
    expect(toolCard.children?.[0].props?.content).toContain(
      "No live prompt is running",
    );
    expect(tab.messages.at(-1)).toMatchObject({
      role: "system",
      text: "Agent stopped.",
    });
    expect(ctx.persistLocalChatMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: "system", text: "Agent stopped." }),
      expect.any(String),
    );
  });

  it("drained queued messages actually reach invoke('send_message') (regression: P1 from peer review)", async () => {
    // Reproduces the bug Codex flagged: useQueuedDispatch previously
    // flipped waiting=true *before* calling sendChat. Because the
    // store mutation is synchronous, sendChat saw the tab as busy
    // and re-queued the popped message with a fresh id, never
    // hitting the bridge. The fix pops the head only and lets
    // sendChat's normal path flip waiting itself.
    const { ctx, stateRef } = buildContext({ waiting: false });
    const { result } = renderHook(() => useChat(ctx));

    // Simulate useQueuedDispatch's contract: pop head, hand off to sendChat.
    act(() => {
      ctx.updateTab("tab-1", (t) => ({
        ...t,
        queuedMessages: [],
        queueCount: 0,
      }));
    });
    await act(async () => {
      await result.current.sendChat("drained", {
        mode: "normal",
        tabId: "tab-1",
      });
    });

    expect(invoke).toHaveBeenCalledWith("send_message", {
      request: {
        message: "drained",
        tabId: "tab-1",
        mode: "normal",
        model: "anthropic/claude-opus-4-7",
      },
    });
    const tab = (stateRef.current.tabs as Tab[])[0];
    expect(tab.queuedMessages).toEqual([]);
    expect(tab.waiting).toBe(true);
    expect(tab.messages.some((m) => m.text === "drained")).toBe(true);
  });

  it("marks the local user message failed when send_message rejects", async () => {
    invoke.mockRejectedValueOnce(new Error("bridge closed"));
    const { ctx, stateRef } = buildContext();
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("lost in transit");
    });

    const messages = (stateRef.current.tabs as Tab[])[0].messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          text: "lost in transit",
          delivery: "failed",
        }),
        expect.objectContaining({
          role: "agent",
          text: expect.stringContaining("Connection error:"),
        }),
      ]),
    );
    expect((stateRef.current.tabs as Tab[])[0].waiting).toBe(false);
  });

  it("sends command-enter messages with steer mode", async () => {
    const { ctx, stateRef } = buildContext({ waiting: true });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("look now", { mode: "steer" });
    });

    expect(invoke).toHaveBeenCalledWith("send_message", {
      request: {
        message: "look now",
        tabId: "tab-1",
        mode: "steer",
        model: "anthropic/claude-opus-4-7",
      },
    });
    expect((stateRef.current.tabs as Tab[])[0].messages.at(-1)).toMatchObject({
      role: "user",
      text: "look now",
      delivery: "steered",
    });
  });

  it("persists streamed assistant snapshots for stopped-turn restore", () => {
    const { ctx, stateRef } = buildContext();
    const { result } = renderHook(() => useChat(ctx));

    act(() => {
      result.current.appendOrAmendAgentText(
        "Inspecting",
        "agent-1",
        "tab-1",
        "thinking",
      );
      result.current.appendOrAmendAgentText(
        "\nDone",
        "agent-1",
        "tab-1",
        "text",
      );
    });

    expect((stateRef.current.tabs as Tab[])[0].messages.at(-1)).toMatchObject({
      id: "agent-1",
      role: "agent",
      createdAt: expect.any(Number),
      thinking: "Inspecting",
      text: "\nDone",
    });
    expect(ctx.persistLocalChatMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "agent-1",
        role: "agent",
        createdAt: expect.any(Number),
        thinking: "Inspecting",
        text: "\nDone",
      }),
      "tab-1",
    );
  });

  it("optimistically mirrors the selected model into the active tab and picker", async () => {
    const { ctx, stateRef, recordProjectModel } = buildContext();
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.setModel("openai/gpt-5.5");
    });

    expect(invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "set_model",
        id: "openai/gpt-5.5",
        tabId: "tab-1",
      }),
    });
    expect(recordProjectModel).toHaveBeenCalledWith("openai/gpt-5.5", "tab-1");
    expect(stateRef.current.model).toBe("openai/gpt-5.5");
    expect(stateRef.current.defaultModel).toBe("openai/gpt-5.5");
    expect((stateRef.current.tabs as Tab[])[0].model).toBe("openai/gpt-5.5");
    expect(
      (
        stateRef.current.sidebar as {
          models: { id: string; active?: boolean }[];
        }
      ).models.find((m) => m.id === "openai/gpt-5.5")?.active,
    ).toBe(true);
  });

  it("leaves the visible model alone while the active prompt is busy", async () => {
    const { ctx, stateRef } = buildContext({ waiting: true });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.setModel("openai/gpt-5.5");
    });

    expect(invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "set_model",
        id: "openai/gpt-5.5",
        tabId: "tab-1",
      }),
    });
    // The live mirror is deferred, but the chosen default still sticks.
    expect(stateRef.current.defaultModel).toBe("openai/gpt-5.5");
    expect(stateRef.current.model).toBe("anthropic/claude-opus-4-7");
    expect((stateRef.current.tabs as Tab[])[0].model).toBe(
      "anthropic/claude-opus-4-7",
    );
  });

  it("sets the default without a phantom session when no agent tab is active", async () => {
    const { ctx, stateRef } = buildContext({
      activeTabId: undefined,
      tabs: [],
    });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.setModel("openai/gpt-5.5");
    });

    // No live session → never invoke set_model (would spin up a phantom).
    expect(invoke).not.toHaveBeenCalledWith("agent_command", expect.anything());
    // …but the default is recorded + mirrored for the header display.
    expect(stateRef.current.defaultModel).toBe("openai/gpt-5.5");
    expect(stateRef.current.model).toBe("openai/gpt-5.5");
    expect(
      (
        stateRef.current.sidebar as {
          models: { id: string; active?: boolean }[];
        }
      ).models.find((m) => m.id === "openai/gpt-5.5")?.active,
    ).toBe(true);
  });

  it("keeps the chosen default even when the live switch fails", async () => {
    const { ctx, stateRef } = buildContext();
    invoke.mockImplementation((...args: unknown[]) =>
      args[0] === "agent_command"
        ? Promise.reject(new Error("agent busy"))
        : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.setModel("openai/gpt-5.5");
    });

    // The live mirror rolls back to the previous model…
    expect(stateRef.current.model).toBe("anthropic/claude-opus-4-7");
    expect((stateRef.current.tabs as Tab[])[0].model).toBe(
      "anthropic/claude-opus-4-7",
    );
    // …but the user's chosen default is intent and must survive.
    expect(stateRef.current.defaultModel).toBe("openai/gpt-5.5");
  });

  it("'(pi default)' clears every runtime fallback and persists null without retargeting", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, stateRef, piDefaultModelRef } = buildContext({
        activeTabId: undefined,
        tabs: [],
        defaultModel: "ollama/qwen",
        piDefaultModel: "ollama/qwen",
        projectModels: { p1: "ollama/qwen" },
      });
      const { result } = renderHook(() => useChat(ctx));

      await act(async () => {
        await result.current.setModel(PI_DEFAULT_MODEL_SENTINEL);
      });

      // Every fallback is cleared so the next new tab sends no model and
      // the agent picks its env default; no live session retarget.
      expect(stateRef.current.defaultModel).toBe("");
      expect(stateRef.current.piDefaultModel).toBe("");
      expect(stateRef.current.model).toBe("");
      expect(stateRef.current.projectModels).toEqual({});
      expect(piDefaultModelRef.current).toBe("");
      expect(invoke).not.toHaveBeenCalledWith(
        "agent_command",
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(450);
      const write = invoke.mock.calls.find((c) => c[0] === "write_config");
      expect(write).toBeTruthy();
      expect(
        (write?.[1] as { config: { agent: { model: string | null } } }).config
          .agent.model,
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the chosen default to [agent] model (debounced)", async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = buildContext();
      const { result } = renderHook(() => useChat(ctx));

      await act(async () => {
        await result.current.setModel("openai/gpt-5.5");
      });
      await vi.advanceTimersByTimeAsync(450);

      const write = invoke.mock.calls.find((c) => c[0] === "write_config");
      expect(write).toBeTruthy();
      expect(
        (write?.[1] as { config: { agent: { model: string } } }).config.agent
          .model,
      ).toBe("openai/gpt-5.5");
    } finally {
      vi.useRealTimers();
    }
  });
});
