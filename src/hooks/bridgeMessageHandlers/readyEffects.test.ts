import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";
import { runReadyEffects } from "./readyEffects";

describe("runReadyEffects", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("replays restored non-default agent tabs through the pending tab-open gate", async () => {
    const { ctx } = buildHandlerFixture({
      state: {
        tabs: [
          {
            id: "tab-1",
            label: "Tab 1",
            model: "claude",
            thinkingLevel: "high",
            cwd: "/repo/a",
            authProfileId: "work",
          },
          { id: "default", label: "Default", model: "claude" },
          { id: "shell-1", kind: "shell", label: "Shell" },
        ],
      },
    });
    const prepareWorkspaceStartup = vi.fn().mockResolvedValue(true);
    ctx.prepareWorkspaceStartup = prepareWorkspaceStartup;

    runReadyEffects(ctx, {
      currentProjectCwd: null,
      priorActiveTabCwd: null,
      priorActiveTabId: "default",
    });

    expect(prepareWorkspaceStartup).toHaveBeenCalledWith("/repo/a");
    expect(ctx.pendingTabOpens.current.has("tab-1")).toBe(true);
    await ctx.pendingTabOpens.current.get("tab-1");
    expect(harness.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "tab_open",
        tabId: "tab-1",
        model: "claude",
        thinkingLevel: "high",
        cwd: "/repo/a",
        authProfileId: "work",
        restoreHistory: true,
      }),
    });
  });

  it("skips tab_open when workspace startup is not ready", async () => {
    const { ctx } = buildHandlerFixture({
      state: {
        tabs: [{ id: "tab-1", label: "Tab 1", model: "claude", cwd: "/repo/a" }],
      },
    });
    ctx.prepareWorkspaceStartup = vi.fn().mockResolvedValue(false);

    runReadyEffects(ctx, {
      currentProjectCwd: null,
      priorActiveTabCwd: null,
      priorActiveTabId: "default",
    });

    await ctx.pendingTabOpens.current.get("tab-1");
    expect(harness.invoke).not.toHaveBeenCalledWith(
      "agent_command",
      expect.anything(),
    );
  });

  it("re-announces the active path or marks startup chrome ready", () => {
    const { ctx, mocks } = buildHandlerFixture();
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorkspaceId: null,
      activeHostId: null,
      projects: [{ id: "p1", label: "p1", path: "/repo/p1", lastUsed: 1 }],
      workspacesByProject: {},
    };

    runReadyEffects(ctx, {
      currentProjectCwd: "/wrong",
      priorActiveTabCwd: null,
      priorActiveTabId: "default",
    });

    expect(mocks.announceProjectToBridge).toHaveBeenCalledWith(
      "default",
      "/repo/p1",
    );
    expect(mocks.markStartupChromeReady).not.toHaveBeenCalled();

    mocks.announceProjectToBridge.mockClear();
    runReadyEffects(ctx, {
      currentProjectCwd: "/repo/p1",
      priorActiveTabCwd: null,
      priorActiveTabId: "default",
    });
    expect(mocks.announceProjectToBridge).not.toHaveBeenCalled();
    expect(mocks.markStartupChromeReady).toHaveBeenCalledTimes(1);
  });
});
