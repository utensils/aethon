// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEmptyTab, type Tab } from "../../types/tab";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";
import { subscribeDevshellOutput } from "./devshellOutput";

const agentTab = (id: string, cwd: string): Tab => ({
  ...makeEmptyTab(id, id, null),
  cwd,
});

const shellTab = (id: string, cwd: string): Tab => ({
  ...makeEmptyTab(id, id, null, "shell"),
  shell: {
    cwd,
    command: "zsh",
    args: [],
    shareMode: "read",
    shellState: "running",
  },
});

describe("subscribeDevshellOutput", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("retains devshell output and appends it to matching agent and shell tabs", async () => {
    let state: Record<string, unknown> = {
      activeTabId: "agent-1",
      terminalPanel: { activeSubId: "shell-1" },
      tabs: [
        agentTab("agent-1", "/repo/workspace"),
        shellTab("shell-1", "/repo/workspace"),
        agentTab("other", "/other"),
      ],
    };
    const stateRef = { current: state };
    const setState = vi.fn((updater: unknown) => {
      state = (updater as (prev: Record<string, unknown>) => Record<string, unknown>)(
        state,
      );
      stateRef.current = state;
    });
    const updateTab = vi.fn();
    const events: Array<{ type: string; detail: unknown }> = [];
    vi.spyOn(window, "dispatchEvent").mockImplementation((event: Event) => {
      events.push({
        type: event.type,
        detail: event instanceof CustomEvent ? event.detail : undefined,
      });
      return true;
    });

    subscribeDevshellOutput({ stateRef, setState, updateTab });
    await Promise.resolve();
    expect(harness.fireEvent("devshell-output", {
      root: "/repo",
      content: "building drv\n",
    })).toBe(1);

    const tabs = state.tabs as Tab[];
    expect(tabs.find((tab) => tab.id === "agent-1")?.terminalBuffer).toBe(
      "building drv\r\n",
    );
    expect(tabs.find((tab) => tab.id === "shell-1")?.terminalBuffer).toBe(
      "building drv\r\n",
    );
    expect(tabs.find((tab) => tab.id === "other")?.terminalBuffer).toBe("");
    expect(
      (state.devshell as { outputByRoot: Record<string, string> }).outputByRoot[
        "/repo"
      ],
    ).toBe("building drv\r\n");
    expect(
      (state.terminal as { buffer: Record<string, string> }).buffer["shell-1"],
    ).toBe("building drv\r\n");
    expect(events).toContainEqual({
      type: "aethon:terminal",
      detail: "building drv\r\n",
    });
    expect(events).toContainEqual({
      type: "aethon:shell-output:shell-1",
      detail: "building drv\r\n",
    });
  });

  it("writes resolving and ready status lines into retained output", async () => {
    let state: Record<string, unknown> = {
      tabs: [agentTab("agent-1", "/repo")],
    };
    const stateRef = { current: state };
    const setState = vi.fn((updater: unknown) => {
      state = (updater as (prev: Record<string, unknown>) => Record<string, unknown>)(
        state,
      );
      stateRef.current = state;
    });

    subscribeDevshellOutput({ stateRef, setState, updateTab: vi.fn() });
    await Promise.resolve();
    harness.fireEvent("devshell-resolving", { root: "/repo", kind: "flake" });
    harness.fireEvent("devshell-ready", {
      root: "/repo",
      kind: "flake",
      durationMs: 1250,
      varCount: 7,
    });

    const output =
      (state.devshell as { outputByRoot: Record<string, string> }).outputByRoot[
        "/repo"
      ];
    expect(output).toContain("Preparing Nix devshell");
    expect(output).toContain("Nix devshell ready in 1.3s (7 vars)");
  });
});
