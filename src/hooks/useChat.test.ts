// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { makeEmptyTab, type Tab } from "../types/tab";
import { useChat, type UseChatContext } from "./useChat";

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

afterEach(() => {
  invoke.mockClear();
});

function buildContext(overrides: Record<string, unknown> = {}): {
  ctx: UseChatContext;
  stateRef: MutableRefObject<Record<string, unknown>>;
  recordProjectModel: ReturnType<typeof vi.fn>;
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
  return {
    stateRef,
    recordProjectModel,
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
    },
  };
}

describe("useChat setModel", () => {
  it("sends normal chat messages with normal mode", async () => {
    const { ctx, stateRef } = buildContext();
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("hello");
    });

    expect(invoke).toHaveBeenCalledWith("send_message", {
      message: "hello",
      tabId: "tab-1",
      mode: "normal",
    });
    expect((stateRef.current.tabs as Tab[])[0].messages.at(-1)).toMatchObject({
      role: "user",
      text: "hello",
      delivery: "sent",
    });
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
      message: "work on issue",
      tabId: "issue-tab",
      mode: "normal",
      cwd: "/projects/aethon-fix-86",
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
      message: "/clear",
      tabId: "issue-tab",
      mode: "normal",
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
      message: "first",
      tabId: "tab-1",
      mode: "steer",
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
    expect(
      (stateRef.current.tabs as Tab[])[0].queuedMessages,
    ).toHaveLength(3);

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
      expect.objectContaining({ message: "after this" }),
    );
    const tab = (stateRef.current.tabs as Tab[])[0];
    expect(tab.queuedMessages.map((m) => m.content)).toEqual(["after this"]);
    expect(tab.queueCount).toBe(1);
    // No user bubble lands in history while queued — the popover owns
    // the visual representation until drain.
    expect(tab.messages.some((m) => m.text === "after this")).toBe(false);
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
    expect(
      (stateRef.current.tabs as Tab[])[0].queuedMessages,
    ).toHaveLength(3);

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
      await result.current.sendChat("drained", { mode: "normal", tabId: "tab-1" });
    });

    expect(invoke).toHaveBeenCalledWith("send_message", {
      message: "drained",
      tabId: "tab-1",
      mode: "normal",
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
      message: "look now",
      tabId: "tab-1",
      mode: "steer",
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
      result.current.appendOrAmendAgentText("Inspecting", "agent-1", "tab-1", "thinking");
      result.current.appendOrAmendAgentText("\nDone", "agent-1", "tab-1", "text");
    });

    expect((stateRef.current.tabs as Tab[])[0].messages.at(-1)).toMatchObject({
      id: "agent-1",
      role: "agent",
      thinking: "Inspecting",
      text: "\nDone",
    });
    expect(ctx.persistLocalChatMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "agent-1",
        role: "agent",
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
    expect(stateRef.current.model).toBe("anthropic/claude-opus-4-7");
    expect((stateRef.current.tabs as Tab[])[0].model).toBe(
      "anthropic/claude-opus-4-7",
    );
  });
});
