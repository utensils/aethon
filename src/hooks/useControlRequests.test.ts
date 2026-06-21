// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installTauriMocks, type TauriMockHarness } from "../test/tauriMocks";
import type { Tab } from "../types/tab";
import { resolveControlWait } from "./controlWaitRegistry";
import { useControlRequests } from "./useControlRequests";

function tab(patch: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    kind: "agent",
    label: "Tab 1",
    projectId: null,
    messages: [],
    draft: "",
    waiting: false,
    queueCount: 0,
    queuedMessages: [],
    canvas: null,
    model: "openai-codex/gpt-5.5",
    terminalBuffer: "",
    cwd: "/repo",
    ...patch,
  };
}

describe("useControlRequests", () => {
  let harness: TauriMockHarness;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  it("switches the requested account before dispatching a controlled chat turn", async () => {
    const stateRef = { current: { activeTabId: "t1", tabs: [tab()] } };
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn((tabId: string, updater: (t: Tab) => Tab) => {
      stateRef.current.tabs = stateRef.current.tabs.map((candidate) =>
        candidate.id === tabId ? updater(candidate) : candidate,
      );
    });
    renderHook(() =>
      useControlRequests({
        stateRef,
        pendingTabOpens: { current: new Map() },
        newTab: vi.fn(),
        closeTabNow: vi.fn(),
        setActiveTab: vi.fn(),
        updateTab,
        sendChat,
        stopPrompt: vi.fn(),
      }),
    );

    harness.fireEvent("control-request", {
      requestId: "control-1",
      method: "chat.send",
      params: {
        message: "hello",
        tabId: "active",
        account: "openai-codex-secondary",
      },
    });

    await waitFor(() =>
      expect(sendChat).toHaveBeenCalledWith("hello", {
        tabId: "t1",
        controlRequestId: "control-1",
      }),
    );
    expect(harness.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "auth_profile_use_for_tab",
        tabId: "t1",
        profileId: "openai-codex-secondary",
      }),
    });
    expect(harness.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "auth_profile_apply",
        tabId: "t1",
        profileId: "openai-codex-secondary",
        cwd: "/repo",
        model: "openai-codex/gpt-5.5",
      }),
    });
    await waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith("control_request_complete", {
        requestId: "control-1",
        success: true,
        data: { sent: true, tabId: "t1", account: "openai-codex-secondary" },
      }),
    );
  });

  it("rejects account switches while the target tab is busy", async () => {
    const stateRef = { current: { activeTabId: "t1", tabs: [tab({ waiting: true })] } };
    renderHook(() =>
      useControlRequests({
        stateRef,
        pendingTabOpens: { current: new Map() },
        newTab: vi.fn(),
        closeTabNow: vi.fn(),
        setActiveTab: vi.fn(),
        updateTab: vi.fn(),
        sendChat: vi.fn(),
        stopPrompt: vi.fn(),
      }),
    );

    harness.fireEvent("control-request", {
      requestId: "control-2",
      method: "accounts.use",
      params: { profileId: "openai-codex-secondary", tabId: "active" },
    });

    await waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith(
        "control_request_complete",
        expect.objectContaining({
          requestId: "control-2",
          success: false,
        }),
      ),
    );
  });

  it("blocks chat.send --wait until the turn's terminal event resolves it", async () => {
    const stateRef = { current: { activeTabId: "t1", tabs: [tab()] } };
    const sendChat = vi.fn(() => Promise.resolve());
    renderHook(() =>
      useControlRequests({
        stateRef,
        pendingTabOpens: { current: new Map() },
        newTab: vi.fn(),
        closeTabNow: vi.fn(),
        setActiveTab: vi.fn(),
        updateTab: vi.fn(),
        sendChat,
        stopPrompt: vi.fn(),
      }),
    );

    harness.fireEvent("control-request", {
      requestId: "control-wait",
      method: "chat.send",
      params: { message: "go", tabId: "active", wait: true, timeoutMs: 10_000 },
    });

    // The chat is dispatched immediately, but the control request must NOT
    // complete until the matching terminal event lands.
    await waitFor(() =>
      expect(sendChat).toHaveBeenCalledWith("go", {
        tabId: "t1",
        controlRequestId: "control-wait",
      }),
    );
    expect(harness.invoke).not.toHaveBeenCalledWith(
      "control_request_complete",
      expect.objectContaining({ requestId: "control-wait" }),
    );

    // The bridge handler resolves the wait when response_end echoes the id.
    resolveControlWait("control-wait", "completed", "t1");

    await waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith(
        "control_request_complete",
        expect.objectContaining({
          requestId: "control-wait",
          success: true,
          data: expect.objectContaining({
            sent: true,
            tabId: "t1",
            wait: expect.objectContaining({ outcome: "completed" }),
          }),
        }),
      ),
    );
  });

  it("falls back to an idle poll when a waited send is queued (no echoed id)", async () => {
    // A send to a busy tab is queued client-side and drained later WITHOUT the
    // controlRequestId, so the deterministic waiter never fires. The wait must
    // still resolve when the tab drains to idle.
    const stateRef = {
      current: { activeTabId: "t1", tabs: [tab({ waiting: true })] },
    };
    const sendChat = vi.fn(() => {
      // Simulate the queued turn draining shortly after dispatch.
      setTimeout(() => {
        stateRef.current = { activeTabId: "t1", tabs: [tab({ waiting: false })] };
      }, 30);
      return Promise.resolve();
    });
    renderHook(() =>
      useControlRequests({
        stateRef,
        pendingTabOpens: { current: new Map() },
        newTab: vi.fn(),
        closeTabNow: vi.fn(),
        setActiveTab: vi.fn(),
        updateTab: vi.fn(),
        sendChat,
        stopPrompt: vi.fn(),
      }),
    );

    harness.fireEvent("control-request", {
      requestId: "control-queued",
      method: "chat.send",
      params: { message: "later", tabId: "active", wait: true, timeoutMs: 10_000 },
    });

    // Resolves via the poll (never via resolveControlWait) once the tab is idle.
    await waitFor(
      () =>
        expect(harness.invoke).toHaveBeenCalledWith(
          "control_request_complete",
          expect.objectContaining({
            requestId: "control-queued",
            success: true,
            data: expect.objectContaining({
              wait: expect.objectContaining({ waiting: false }),
            }),
          }),
        ),
      { timeout: 4000 },
    );
  });

  it("applies --plan / --thinking-level onto the target tab before dispatch", async () => {
    const stateRef = { current: { activeTabId: "t1", tabs: [tab()] } };
    const updateTab = vi.fn();
    const sendChat = vi.fn(() => Promise.resolve());
    renderHook(() =>
      useControlRequests({
        stateRef,
        pendingTabOpens: { current: new Map() },
        newTab: vi.fn(),
        closeTabNow: vi.fn(),
        setActiveTab: vi.fn(),
        updateTab,
        sendChat,
        stopPrompt: vi.fn(),
      }),
    );

    harness.fireEvent("control-request", {
      requestId: "control-opts",
      method: "chat.send",
      params: {
        message: "x",
        tabId: "active",
        planMode: true,
        thinkingLevel: "high",
      },
    });

    await waitFor(() => expect(sendChat).toHaveBeenCalled());
    const mutator = updateTab.mock.calls.find((call) => call[0] === "t1")?.[1];
    expect(mutator).toBeTypeOf("function");
    expect(mutator(tab())).toMatchObject({ planMode: true, thinkingLevel: "high" });
  });
});
