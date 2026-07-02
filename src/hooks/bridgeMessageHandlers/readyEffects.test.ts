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

  it("replays exact .aethon-root tabs but not legacy project mirrors", async () => {
    const { ctx } = buildHandlerFixture({
      state: {
        tabs: [
          {
            id: "state-root",
            label: "State Root",
            cwd: "/Users/jamesbrink/.aethon",
          },
          {
            id: "legacy-project",
            label: "Legacy Project",
            cwd: "/Users/jamesbrink/.aethon/aethon/fix-old-worktree",
          },
          {
            id: "managed-project",
            label: "Managed Project",
            cwd: "/Users/jamesbrink/.aethon/projects/project-id/worktree",
          },
        ],
      },
    });
    ctx.prepareWorkspaceStartup = vi.fn().mockResolvedValue(true);

    runReadyEffects(ctx, {
      currentProjectCwd: null,
      priorActiveTabCwd: null,
      priorActiveTabId: "default",
    });

    // The exact `~/.aethon` root is the bridge's fallback cwd for tabs with
    // no active project — a live session that must survive reload. Only
    // legacy project MIRRORS under the state dir stay excluded.
    expect(ctx.pendingTabOpens.current.has("state-root")).toBe(true);
    expect(ctx.pendingTabOpens.current.has("legacy-project")).toBe(false);
    expect(ctx.pendingTabOpens.current.has("managed-project")).toBe(true);
    await ctx.pendingTabOpens.current.get("managed-project");
    expect(ctx.prepareWorkspaceStartup).toHaveBeenCalledWith(
      "/Users/jamesbrink/.aethon",
    );
    expect(ctx.prepareWorkspaceStartup).toHaveBeenCalledWith(
      "/Users/jamesbrink/.aethon/projects/project-id/worktree",
    );
    expect(ctx.prepareWorkspaceStartup).not.toHaveBeenCalledWith(
      "/Users/jamesbrink/.aethon/aethon/fix-old-worktree",
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
    expect(mocks.markStartupChromeReady).toHaveBeenCalledTimes(1);

    mocks.announceProjectToBridge.mockClear();
    mocks.markStartupChromeReady.mockClear();
    runReadyEffects(ctx, {
      currentProjectCwd: "/repo/p1",
      priorActiveTabCwd: null,
      priorActiveTabId: "default",
    });
    expect(mocks.announceProjectToBridge).not.toHaveBeenCalled();
    expect(mocks.markStartupChromeReady).toHaveBeenCalledTimes(1);
  });

  it("re-announces a prior active tab at the exact .aethon root but not a legacy mirror", () => {
    const { ctx, mocks } = buildHandlerFixture();
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorkspaceId: null,
      activeHostId: null,
      projects: [{ id: "p1", label: "p1", path: "/repo/p1", lastUsed: 1 }],
      workspacesByProject: {},
    };

    // Exact `~/.aethon` = the bridge's fallback cwd for project-less tabs;
    // a live session there re-announces its own cwd after reload.
    runReadyEffects(ctx, {
      currentProjectCwd: "/wrong",
      priorActiveTabCwd: "/Users/jamesbrink/.aethon",
      priorActiveTabId: "state-root",
    });
    expect(mocks.announceProjectToBridge).toHaveBeenCalledWith(
      "state-root",
      "/Users/jamesbrink/.aethon",
    );
    expect(mocks.markStartupChromeReady).toHaveBeenCalledTimes(1);

    // A legacy mirror under the state dir still falls back to the active
    // project path instead of resurrecting the junk cwd.
    mocks.announceProjectToBridge.mockClear();
    mocks.markStartupChromeReady.mockClear();
    runReadyEffects(ctx, {
      currentProjectCwd: "/wrong",
      priorActiveTabCwd: "/Users/jamesbrink/.aethon/aethon/fix-old-worktree",
      priorActiveTabId: "legacy-tab",
    });
    expect(mocks.announceProjectToBridge).toHaveBeenCalledWith(
      "legacy-tab",
      "/repo/p1",
    );
    expect(mocks.announceProjectToBridge).not.toHaveBeenCalledWith(
      "legacy-tab",
      "/Users/jamesbrink/.aethon/aethon/fix-old-worktree",
    );
    expect(mocks.markStartupChromeReady).toHaveBeenCalledTimes(1);
  });
});
