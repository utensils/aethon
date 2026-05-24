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

  it("marks normal messages as queued while the active prompt is busy", async () => {
    const { ctx, stateRef } = buildContext({ waiting: true });
    const { result } = renderHook(() => useChat(ctx));

    await act(async () => {
      await result.current.sendChat("after this");
    });

    expect(invoke).toHaveBeenCalledWith("send_message", {
      message: "after this",
      tabId: "tab-1",
      mode: "normal",
    });
    expect((stateRef.current.tabs as Tab[])[0].messages.at(-1)).toMatchObject({
      role: "user",
      text: "after this",
      delivery: "queued",
    });
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
