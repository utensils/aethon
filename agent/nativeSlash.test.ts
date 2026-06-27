import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureTabMock = vi.hoisted(() => vi.fn());

vi.mock("./tab-lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tab-lifecycle")>();
  return {
    ...actual,
    ensureTab: ensureTabMock,
  };
});

import { handleNativeSlashCommand } from "./nativeSlash";
import type { AethonAgentState } from "./state";
import type { DispatcherDeps } from "./dispatcherTypes";

function makeDeps(): { deps: DispatcherDeps; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    deps: {
      send: (message: Record<string, unknown>) => sent.push(message),
      scheduleStateFileWrite: () => {},
      loadHooks: {},
    },
    sent,
  };
}

function makeState(): AethonAgentState {
  return {
    tabProjectCwds: new Map<string, string>(),
  } as unknown as AethonAgentState;
}

describe("handleNativeSlashCommand", () => {
  beforeEach(() => {
    ensureTabMock.mockReset();
  });

  it("opens a slash-command session with the cwd carried by the frontend", async () => {
    const runExtensionCommand = vi.fn(() => Promise.resolve(true));
    ensureTabMock.mockResolvedValue({
      session: {
        _tryExecuteExtensionCommand: runExtensionCommand,
      },
    });
    const state = makeState();
    const { deps, sent } = makeDeps();

    await handleNativeSlashCommand(state, deps, {
      type: "native_slash_command",
      name: "mcp",
      args: "tools",
      tabId: "tab-1",
      cwd: "/repo/worktree",
    });

    expect(ensureTabMock).toHaveBeenCalledWith(state, deps, "tab-1", {
      cwdOverride: "/repo/worktree",
    });
    expect(state.tabProjectCwds.get("tab-1")).toBe("/repo/worktree");
    expect(runExtensionCommand).toHaveBeenCalledWith("/mcp tools");
    expect(sent).toEqual([]);
  });

  it("runs extension slash commands with cwd override even when ensureTab reuses an existing session", async () => {
    const session = {
      _extensionRunner: { cwd: "/repo/old" },
      _tryExecuteExtensionCommand: vi.fn(function (this: {
        _extensionRunner: { cwd: string };
      }) {
        return Promise.resolve(this._extensionRunner.cwd === "/repo/worktree");
      }),
    };
    ensureTabMock.mockResolvedValue({ session });
    const state = makeState();
    const { deps, sent } = makeDeps();

    await handleNativeSlashCommand(state, deps, {
      type: "native_slash_command",
      name: "mcp",
      args: "tools",
      tabId: "default",
      cwd: "/repo/worktree",
    });

    expect(session._tryExecuteExtensionCommand).toHaveBeenCalledWith(
      "/mcp tools",
    );
    expect(session._extensionRunner.cwd).toBe("/repo/old");
    expect(state.tabProjectCwds.get("default")).toBe("/repo/worktree");
    expect(sent).toEqual([]);
  });

  it("sets and removes the temporary cwd override when the runner had no cwd", async () => {
    const session = {
      _extensionRunner: {} as { cwd?: string },
      _tryExecuteExtensionCommand: vi.fn(function (this: {
        _extensionRunner: { cwd?: string };
      }) {
        return Promise.resolve(this._extensionRunner.cwd === "/repo/worktree");
      }),
    };
    ensureTabMock.mockResolvedValue({ session });
    const state = makeState();
    const { deps, sent } = makeDeps();

    await handleNativeSlashCommand(state, deps, {
      type: "native_slash_command",
      name: "mcp",
      args: "tools",
      tabId: "tab-1",
      cwd: "/repo/worktree",
    });

    expect(session._tryExecuteExtensionCommand).toHaveBeenCalledWith(
      "/mcp tools",
    );
    expect(session._extensionRunner).not.toHaveProperty("cwd");
    expect(state.tabProjectCwds.get("tab-1")).toBe("/repo/worktree");
    expect(sent).toEqual([]);
  });
});
