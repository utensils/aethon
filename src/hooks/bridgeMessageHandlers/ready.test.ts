import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleReady } from "./ready";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("handleReady", () => {
  beforeEach(() => {
    installTauriMocks();
  });
  afterEach(() => {
    clearTauriMocks();
  });

  it("hydrates extensions, sets layout, fills active model, and pushes ready status", () => {
    const { ctx, mocks, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: "default",
        tabs: [{ id: "default", model: "" }],
        sidebar: {},
      },
    });
    handleReady(
      {
        type: "ready",
        model: "claude",
        models: [
          { id: "claude", label: "Claude", provider: "anthropic" },
          { id: "gpt", label: "GPT", provider: "openai" },
        ],
        extensionsList: [{ name: "ext-a", source: "directory" }],
        failedExtensionsList: [],
        extensionThemes: [],
        extensionSlashCommands: [],
        piSlashCommands: [
          {
            name: "prompt-review",
            description: "Review prompt",
            source: "prompt",
          },
          {
            name: "skill:claudex",
            description: "Query sessions",
            source: "skill",
          },
        ],
        extensionKeybindings: [],
        extensionEventRoutes: [],
        extensionLayouts: [],
        extensionFrontendModules: [],
        extensionStateKeys: [],
        extensionMenuItems: [],
        discoveredTabs: [],
        tabs: [{ id: "default", model: "claude" }],
        extensionTabState: {},
      },
      ctx,
    );
    expect(ctx.piDefaultModelRef.current).toBe("claude");
    expect(mocks.hydrateThemes).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateExtensions).toHaveBeenCalledWith(
      [{ name: "ext-a", source: "directory" }],
      [],
      [],
      null,
      // Empty set — the testFixture's projectsRef has no projects loaded,
      // so the npm-scope heuristic has no project basenames to match
      // against and every @scope/pkg is treated as global.
      new Set(),
    );
    expect(mocks.hydrateSlashCommands).toHaveBeenCalledWith(
      [],
      [
        {
          name: "prompt-review",
          description: "Review prompt",
          source: "prompt",
        },
        {
          name: "skill:claudex",
          description: "Query sessions",
          source: "skill",
        },
      ],
    );
    expect(mocks.setLayout).toHaveBeenCalledTimes(1);
    const next = applySetState({
      activeTabId: "default",
      tabs: [{ id: "default", model: "" }],
      sidebar: {},
    });
    expect(next.status).toBe("ready");
    expect(next.connection).toBe("connected");
    expect(next.model).toBe("claude");
    expect(
      (next.sidebar as { models: { id: string; active: boolean }[] }).models,
    ).toEqual([
      { id: "claude", label: "Claude", active: true },
      { id: "gpt", label: "GPT", active: false },
    ]);
  });

  it("keeps the configured default model ahead of the bridge fallback", () => {
    const configuredModel = "openai/user-configured-model";
    const bridgeFallbackModel = "anthropic/provider-default-model";
    const { ctx, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: "default",
        tabs: [{ id: "default", model: "" }],
        sidebar: {},
        piDefaultModel: configuredModel,
      },
    });
    ctx.piDefaultModelRef.current = configuredModel;
    handleReady(
      {
        type: "ready",
        model: bridgeFallbackModel,
        models: [
          {
            id: bridgeFallbackModel,
            label: "Provider Default",
            provider: "anthropic",
          },
          { id: configuredModel, label: "Configured", provider: "openai" },
        ],
        extensionStateKeys: [],
        discoveredTabs: [],
        tabs: [{ id: "default", model: bridgeFallbackModel }],
      },
      ctx,
    );

    const next = applySetState();
    expect(ctx.piDefaultModelRef.current).toBe(configuredModel);
    expect(next.model).toBe(configuredModel);
    expect(next.piDefaultModel).toBe(configuredModel);
    expect((next.tabs as { id: string; model: string }[])[0].model).toBe(
      configuredModel,
    );
    expect(
      (next.sidebar as { models: { id: string; active: boolean }[] }).models,
    ).toEqual([
      { id: bridgeFallbackModel, label: "Provider Default", active: false },
      { id: configuredModel, label: "Configured", active: true },
    ]);
  });

  it("prunes extension state keys that disappeared between readies", () => {
    const { ctx, applySetState } = buildHandlerFixture({
      state: { activeTabId: "default", tabs: [{ id: "default" }], sidebar: {} },
    });
    ctx.lastExtensionStateKeysRef.current = new Set(["/old", "/keep"]);
    handleReady(
      {
        type: "ready",
        model: "claude",
        models: [],
        extensionStateKeys: ["/keep"],
        tabs: [{ id: "default", model: "claude" }],
      },
      ctx,
    );
    expect(ctx.lastExtensionStateKeysRef.current.has("/old")).toBe(false);
    expect(ctx.lastExtensionStateKeysRef.current.has("/keep")).toBe(true);
    const next = applySetState({
      activeTabId: "default",
      tabs: [{ id: "default" }],
      sidebar: {},
      old: "stale",
      keep: "live",
    });
    expect(next).not.toHaveProperty("old");
  });

  it("restores default layout state after pruning project-owned layout paths", () => {
    const { ctx, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: "default",
        tabs: [{ id: "default" }],
        layout: {
          columns: "220px minmax(0,1fr) 360px",
          areas: ["sidebar header gallery"],
        },
        sidebar: {
          extraSections: [{ id: "gallery", title: "Local gallery" }],
        },
      },
    });
    ctx.bootLayout = {
      components: [{ id: "root", type: "container" }],
      state: {
        layout: {
          columns: "220px minmax(0,1fr)",
          areas: ["sidebar header", "sidebar canvas", "sidebar composer"],
        },
        sidebar: {
          extraSections: [],
        },
      },
    };
    ctx.lastExtensionStateKeysRef.current = new Set([
      "/layout/columns",
      "/layout/areas",
      "/sidebar/extraSections",
    ]);

    handleReady(
      {
        type: "ready",
        model: "claude",
        models: [],
        extensionStateKeys: [],
        tabs: [{ id: "default", model: "claude" }],
      },
      ctx,
    );

    const next = applySetState();
    expect(next.layout).toMatchObject({
      columns: "220px minmax(0,1fr)",
      areas: ["sidebar header", "sidebar canvas", "sidebar composer"],
    });
    expect(next.sidebar).toMatchObject({ extraSections: [] });
  });

  it("calls auto-restore only after projects are loaded", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleReady({ type: "ready", tabs: [], discoveredTabs: [] }, ctx);
    expect(mocks.autoRestoreDiscoveredSessions).not.toHaveBeenCalled();

    const second = buildHandlerFixture();
    second.ctx.projectsLoadedRef.current = true;
    handleReady(
      {
        type: "ready",
        tabs: [],
        discoveredTabs: [{ tabId: "x", lastModified: 1 }],
      },
      second.ctx,
    );
    expect(second.mocks.autoRestoreDiscoveredSessions).toHaveBeenCalledTimes(1);
  });

  it("re-announces the active project after a respawn", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default", tabs: [] },
    });
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorktreeId: null,
      worktreesByProject: {},
      activeHostId: null,
      projects: [
        { id: "p1", label: "p1", path: "/tmp/p1", lastUsed: Date.now() },
      ],
    };
    handleReady({ type: "ready", model: "claude", tabs: [] }, ctx);
    expect(mocks.announceProjectToBridge).toHaveBeenCalledWith(
      "default",
      "/tmp/p1",
    );
  });

  it("requests transcript replay for non-default open tabs after ready", () => {
    const harness = installTauriMocks();
    const { ctx } = buildHandlerFixture({
      state: {
        activeTabId: "default",
        tabs: [
          { id: "default", model: "claude", projectId: "p2" },
          { id: "tab-2", model: "gpt", projectId: "p1" },
        ],
      },
    });
    ctx.projectsRef.current = {
      activeId: "p2",
      activeWorktreeId: null,
      worktreesByProject: {},
      activeHostId: null,
      projects: [
        { id: "p1", label: "A", path: "/repo/a", lastUsed: 1 },
        { id: "p2", label: "B", path: "/repo/b", lastUsed: 2 },
      ],
    };
    handleReady(
      {
        type: "ready",
        model: "claude",
        tabs: [{ id: "default", model: "claude" }],
      },
      ctx,
    );
    const payloads = harness.invoke.mock.calls
      .filter((call) => call[0] === "agent_command")
      .map((call) => JSON.parse(call[1].payload as string));
    expect(payloads).toEqual([
      expect.objectContaining({
        type: "tab_open",
        tabId: "tab-2",
        restoreHistory: true,
        cwd: "/repo/a",
      }),
    ]);
  });

  it("requests transcript replay for worktree tabs with their tab cwd", () => {
    const harness = installTauriMocks();
    const { ctx } = buildHandlerFixture({
      state: {
        activeTabId: "tab-2",
        tabs: [
          {
            id: "tab-2",
            model: "gpt",
            projectId: "p1",
            cwd: "/repo/a-fix-session-restore",
          },
        ],
      },
    });
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorktreeId: "wt-1",
      worktreesByProject: {
        p1: [
          {
            id: "wt-1",
            projectId: "p1",
            path: "/repo/a-fix-session-restore",
            branch: "fix/session-restore",
            isMain: false,
          },
        ],
      },
      activeHostId: null,
      projects: [{ id: "p1", label: "A", path: "/repo/a", lastUsed: 1 }],
    };
    handleReady(
      {
        type: "ready",
        model: "claude",
        tabs: [{ id: "default", model: "claude" }],
      },
      ctx,
    );
    const payloads = harness.invoke.mock.calls
      .filter((call) => call[0] === "agent_command")
      .map((call) => JSON.parse(call[1].payload as string));
    expect(payloads).toEqual([
      expect.objectContaining({
        type: "tab_open",
        tabId: "tab-2",
        restoreHistory: true,
        cwd: "/repo/a-fix-session-restore",
      }),
    ]);
  });

  it("does not backfill bridge tabs into the visible project bucket", () => {
    const { ctx, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: "default",
        tabs: [{ id: "default", model: "claude", projectId: "p2" }],
        sidebar: {},
      },
    });
    ctx.projectsRef.current = {
      activeId: "p2",
      activeWorktreeId: null,
      worktreesByProject: {},
      activeHostId: null,
      projects: [
        { id: "p1", label: "A", path: "/repo/a", lastUsed: 1 },
        { id: "p2", label: "B", path: "/repo/b", lastUsed: 2 },
      ],
    };

    handleReady(
      {
        type: "ready",
        model: "claude",
        tabs: [
          { id: "default", model: "claude", cwd: "/repo/b" },
          { id: "tab-a", model: "gpt", cwd: "/repo/a" },
          { id: "tab-b", model: "gpt", cwd: "/repo/b" },
          { id: "tab-unknown", model: "gpt" },
        ],
      },
      ctx,
    );

    const next = applySetState();
    expect((next.tabs as { id: string }[]).map((t) => t.id)).toEqual([
      "default",
    ]);
  });
});

// Quiet the ESLint vi-unused warning when fake timers aren't used.
void vi;
