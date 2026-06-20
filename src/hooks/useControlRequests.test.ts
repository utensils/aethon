// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installTauriMocks, type TauriMockHarness } from "../test/tauriMocks";
import type { Tab } from "../types/tab";
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
});
