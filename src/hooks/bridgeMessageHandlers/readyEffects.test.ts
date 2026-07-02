import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";
import {
  discardDeferredTabOpen,
  flushDeferredTabOpen,
  hasDeferredTabOpen,
  resetReplayedTabsForTest,
  runReadyEffects,
} from "./readyEffects";

describe("runReadyEffects", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
    resetReplayedTabsForTest();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("eagerly replays the active restored tab through the pending tab-open gate", async () => {
    const { ctx } = buildHandlerFixture({
      state: {
        activeTabId: "tab-1",
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
      bridgeTabIds: new Set<string>(),
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

  it("defers background restored tabs and opens them on flush", async () => {
    const { ctx } = buildHandlerFixture({
      state: {
        activeTabId: "tab-active",
        tabs: [
          { id: "tab-active", label: "Active", model: "claude", cwd: "/repo/a" },
          { id: "tab-bg", label: "Background", model: "claude", cwd: "/repo/b" },
        ],
      },
    });
    ctx.prepareWorkspaceStartup = vi.fn().mockResolvedValue(true);

    runReadyEffects(ctx, {
      currentProjectCwd: null,
      priorActiveTabCwd: null,
      priorActiveTabId: "default",
      bridgeTabIds: new Set<string>(),
    });

    // Only the visible tab hit the bridge; the background tab holds a
    // deferred open — this is the 1-cold-boot (not 1+N) property.
    expect(ctx.pendingTabOpens.current.has("tab-active")).toBe(true);
    expect(ctx.pendingTabOpens.current.has("tab-bg")).toBe(false);
    expect(hasDeferredTabOpen("tab-bg")).toBe(true);

    const opening = flushDeferredTabOpen("tab-bg");
    expect(opening).toBeDefined();
    expect(hasDeferredTabOpen("tab-bg")).toBe(false);
    expect(ctx.pendingTabOpens.current.has("tab-bg")).toBe(true);
    await opening;
    expect(harness.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "tab_open",
        tabId: "tab-bg",
        model: "claude",
        cwd: "/repo/b",
        restoreHistory: true,
      }),
    });
    // A second flush is a no-op — the open is single-shot.
    expect(flushDeferredTabOpen("tab-bg")).toBeUndefined();
  });

  it("discards a deferred open without touching the bridge", () => {
    const { ctx } = buildHandlerFixture({
      state: {
        activeTabId: "default",
        tabs: [
          { id: "tab-bg", label: "Background", model: "claude", cwd: "/repo/b" },
        ],
      },
    });
    ctx.prepareWorkspaceStartup = vi.fn().mockResolvedValue(true);

    runReadyEffects(ctx, {
      currentProjectCwd: null,
      priorActiveTabCwd: null,
      priorActiveTabId: "default",
      bridgeTabIds: new Set<string>(),
    });
    expect(hasDeferredTabOpen("tab-bg")).toBe(true);

    discardDeferredTabOpen("tab-bg");
    expect(hasDeferredTabOpen("tab-bg")).toBe(false);
    expect(flushDeferredTabOpen("tab-bg")).toBeUndefined();
    expect(harness.invoke).not.toHaveBeenCalledWith(
      "agent_command",
      expect.anything(),
    );
  });

  it("skips tab_open when workspace startup is not ready", async () => {
    const { ctx } = buildHandlerFixture({
      state: {
        activeTabId: "tab-1",
        tabs: [{ id: "tab-1", label: "Tab 1", model: "claude", cwd: "/repo/a" }],
      },
    });
    ctx.prepareWorkspaceStartup = vi.fn().mockResolvedValue(false);

    runReadyEffects(ctx, {
      currentProjectCwd: null,
      priorActiveTabCwd: null,
      priorActiveTabId: "default",
      bridgeTabIds: new Set<string>(),
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
        activeTabId: "state-root",
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
      bridgeTabIds: new Set<string>(),
    });

    // The exact `~/.aethon` root is the bridge's fallback cwd for tabs with
    // no active project — a live session that must survive reload. Only
    // legacy project MIRRORS under the state dir stay excluded — no eager
    // open AND no deferred open.
    expect(ctx.pendingTabOpens.current.has("state-root")).toBe(true);
    expect(ctx.pendingTabOpens.current.has("legacy-project")).toBe(false);
    expect(hasDeferredTabOpen("legacy-project")).toBe(false);
    expect(hasDeferredTabOpen("managed-project")).toBe(true);
    await flushDeferredTabOpen("managed-project");
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
      bridgeTabIds: new Set<string>(),
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
      bridgeTabIds: new Set<string>(),
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
      bridgeTabIds: new Set<string>(),
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
      bridgeTabIds: new Set<string>(),
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

  it("replays each tab once per webview lifetime unless the bridge loses it", async () => {
    const { ctx } = buildHandlerFixture({
      state: {
        activeTabId: "tab-1",
        tabs: [
          { id: "tab-1", label: "One", model: "claude", cwd: "/repo/a" },
          { id: "tab-2", label: "Two", model: "claude", cwd: "/repo/b" },
        ],
      },
    });
    ctx.prepareWorkspaceStartup = vi.fn().mockResolvedValue(true);
    const input = {
      currentProjectCwd: null,
      priorActiveTabCwd: null,
      priorActiveTabId: "default",
    };

    // First ready after webview load: the active tab replays, the
    // background tab defers.
    runReadyEffects(ctx, {
      ...input,
      bridgeTabIds: new Set(["tab-1", "tab-2"]),
    });
    const firstOpen = ctx.pendingTabOpens.current.get("tab-1");
    expect(firstOpen).toBeDefined();
    expect(hasDeferredTabOpen("tab-2")).toBe(true);

    // A ready that re-fires while that open is still in flight (the
    // bridge snapshot can't reflect it yet) must not double-send.
    runReadyEffects(ctx, {
      ...input,
      bridgeTabIds: new Set<string>(),
    });
    expect(ctx.pendingTabOpens.current.get("tab-1")).toBe(firstOpen);

    // First interaction with the background tab opens it.
    await flushDeferredTabOpen("tab-2");

    // Let the .finally() cleanup that clears pendingTabOpens flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.pendingTabOpens.current.size).toBe(0);

    // ready re-fires constantly (project switches, reports from other
    // clients). Re-replaying live tabs re-emitted session_history
    // mid-stream and flipped the global project per ready — skip both
    // the eager and deferred paths.
    runReadyEffects(ctx, {
      ...input,
      bridgeTabIds: new Set(["tab-1", "tab-2"]),
    });
    expect(ctx.pendingTabOpens.current.size).toBe(0);
    expect(hasDeferredTabOpen("tab-2")).toBe(false);

    // Bridge respawned and lost tab-2: it defers again (background),
    // and opens on the next interaction.
    runReadyEffects(ctx, {
      ...input,
      bridgeTabIds: new Set(["tab-1"]),
    });
    expect(ctx.pendingTabOpens.current.has("tab-1")).toBe(false);
    expect(hasDeferredTabOpen("tab-2")).toBe(true);
    await flushDeferredTabOpen("tab-2");
  });

  it("on the mobile surface, neither replays tabs nor announces a project", () => {
    vi.stubEnv("VITE_AETHON_SURFACE", "mobile");
    try {
      const { ctx, mocks } = buildHandlerFixture({
        state: {
          tabs: [
            { id: "tab-1", label: "Tab 1", model: "claude", cwd: "/repo/a" },
          ],
        },
      });
      ctx.prepareWorkspaceStartup = vi.fn().mockResolvedValue(true);
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
        bridgeTabIds: new Set<string>(),
      });

      // The companion is a passive reader: announcing its own local view
      // back at the bridge is what livelocked set_project when desktop
      // and mobile disagreed on the active project.
      expect(mocks.announceProjectToBridge).not.toHaveBeenCalled();
      expect(ctx.pendingTabOpens.current.size).toBe(0);
      expect(mocks.markStartupChromeReady).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
