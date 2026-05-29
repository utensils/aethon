import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleReady } from "./ready";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";
import { makeEmptyTab } from "../../types/tab";
import { defaultLayoutExtension } from "../../extensions/default-layout";

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
        projectRoot: "/repo/aethon",
        userDir: "/Users/me/.aethon",
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
    expect(next.projectRoot).toBe("/repo/aethon");
    expect(next.aethonRoot).toBe("/Users/me/.aethon");
    expect(
      (next.sidebar as { models: { id: string; active: boolean }[] }).models,
    ).toEqual([
      { id: "claude", label: "Claude", active: true },
      { id: "gpt", label: "GPT", active: false },
    ]);
  });

  it("does not overwrite an active running turn with ready status", () => {
    const { ctx, applySetState } = buildHandlerFixture();
    handleReady(
      {
        type: "ready",
        model: "claude",
        models: [{ id: "claude", label: "Claude" }],
      },
      ctx,
    );
    const next = applySetState({
      activeTabId: "tab-1",
      waiting: true,
      queueCount: 2,
      tabs: [
        {
          ...makeEmptyTab("tab-1", "Tab 1"),
          model: "claude",
          waiting: true,
          queueCount: 2,
        },
      ],
      sidebar: {},
    });
    expect(next.status).toBe("thinking…");
    expect(next.connection).toBe("connected");
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
    ctx.bootLayout = defaultLayoutExtension.layout!;
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
      columns: "264px minmax(0,1fr) 360px",
      rows: "38px 38px minmax(0,1fr) 0px auto auto",
      areas: [
        "sidebar header files-sidebar",
        "sidebar tabs files-sidebar",
        "sidebar canvas files-sidebar",
        "sidebar terminal files-sidebar",
        "sidebar composer files-sidebar",
        "status status status",
      ],
    });
    expect(next.sidebar).toMatchObject({ extraSections: [] });
  });

  it("normalizes stale workstation grid state so the top tab strip has a row", () => {
    const { ctx, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: "default",
        tabs: [{ id: "default" }],
        layout: {
          columns: "220px minmax(0,1fr) 360px",
          rows: "38px minmax(0,1fr) 0px auto auto",
          areas: [
            "sidebar header files-sidebar",
            "sidebar canvas files-sidebar",
            "sidebar terminal files-sidebar",
            "sidebar composer files-sidebar",
            "status status status",
          ],
        },
      },
    });
    ctx.bootLayout = defaultLayoutExtension.layout!;

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
      rows: "38px 38px minmax(0,1fr) 0px auto auto",
      areas: [
        "sidebar header files-sidebar",
        "sidebar tabs files-sidebar",
        "sidebar canvas files-sidebar",
        "sidebar terminal files-sidebar",
        "sidebar composer files-sidebar",
        "status status status",
      ],
    });
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

  it("keeps discovered sessions resumable when the bridge knows a tab the UI lost", () => {
    const { ctx, mocks, applySetState } = buildHandlerFixture({
      state: { activeTabId: undefined, tabs: [], sidebar: {} },
    });
    const discovered = [
      {
        tabId: "lost-tab",
        lastModified: 1710000000000,
        cwd: "/repo/aethon-fix",
      },
    ];
    mocks.knownTabIds.mockImplementation((extraTabs?: { id: string }[]) => {
      const ids = new Set<string>(["default"]);
      for (const tab of extraTabs ?? []) ids.add(tab.id);
      return ids;
    });
    mocks.recentSessionItems.mockReturnValue([
      {
        id: "lost-tab",
        label: "Lost but resumable",
        lastModified: "2m ago",
        cwd: "/repo/aethon-fix",
      },
    ]);

    handleReady(
      {
        type: "ready",
        model: "claude",
        models: [],
        discoveredTabs: discovered,
        tabs: [{ id: "lost-tab", model: "claude", cwd: "/repo/aethon-fix" }],
      },
      ctx,
    );

    expect(mocks.knownTabIds).toHaveBeenNthCalledWith(1);
    expect(mocks.knownTabIds).toHaveBeenNthCalledWith(2, [
      { id: "lost-tab", model: "claude", cwd: "/repo/aethon-fix" },
    ]);
    expect(mocks.recentSessionItems).toHaveBeenCalledWith(
      discovered,
      new Set(["default"]),
    );
    expect(applySetState().recentSessions).toEqual([
      expect.objectContaining({ id: "lost-tab" }),
    ]);
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

  it("does not re-announce the active project when ready already reports that cwd", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default", tabs: [] },
    });
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorktreeId: null,
      worktreesByProject: {},
      activeHostId: null,
      projects: [{ id: "p1", label: "p1", path: "/tmp/p1", lastUsed: 1 }],
    };

    handleReady(
      {
        type: "ready",
        model: "claude",
        tabs: [],
        currentProjectCwd: "/tmp/p1",
      },
      ctx,
    );

    expect(mocks.announceProjectToBridge).not.toHaveBeenCalled();
  });

  it("re-announces the active worktree cwd, not the project root", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [{ id: "tab-1" }] },
    });
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorktreeId: "wt-1",
      activeHostId: null,
      projects: [{ id: "p1", label: "p1", path: "/tmp/p1", lastUsed: 1 }],
      worktreesByProject: {
        p1: [
          {
            id: "wt-1",
            projectId: "p1",
            path: "/tmp/p1-fix",
            branch: "fix/reload",
            isMain: false,
          },
        ],
      },
    };

    handleReady(
      {
        type: "ready",
        model: "claude",
        tabs: [{ id: "tab-1", model: "claude", cwd: "/tmp/other" }],
        currentProjectCwd: "/tmp/other",
      },
      ctx,
    );

    expect(mocks.announceProjectToBridge).toHaveBeenCalledWith(
      "tab-1",
      "/tmp/p1-fix",
    );
  });

  it("re-announces the active tab cwd even when the project worktree selection was cleared", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: {
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            kind: "agent",
            projectId: "p1",
            cwd: "/tmp/p1-fix",
          },
        ],
      },
    });
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorktreeId: null,
      activeHostId: null,
      projects: [{ id: "p1", label: "p1", path: "/tmp/p1", lastUsed: 1 }],
      worktreesByProject: {
        p1: [
          {
            id: "wt-1",
            projectId: "p1",
            path: "/tmp/p1-fix",
            branch: "fix/reload",
            isMain: false,
          },
        ],
      },
    };

    handleReady(
      {
        type: "ready",
        model: "claude",
        tabs: [{ id: "tab-1", model: "claude", cwd: "/tmp/p1-fix" }],
        currentProjectCwd: "/tmp/p1",
      },
      ctx,
    );

    expect(mocks.announceProjectToBridge).toHaveBeenCalledWith(
      "tab-1",
      "/tmp/p1-fix",
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

  it("does not replay tab_open for non-default tabs already present in bridge ready data", () => {
    const harness = installTauriMocks();
    const { ctx } = buildHandlerFixture({
      state: {
        activeTabId: "tab-2",
        tabs: [
          { id: "default", model: "claude", projectId: "p1" },
          { id: "tab-2", model: "gpt", projectId: "p1", cwd: "/repo/a" },
        ],
      },
    });
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorktreeId: null,
      worktreesByProject: {},
      activeHostId: null,
      projects: [{ id: "p1", label: "A", path: "/repo/a", lastUsed: 1 }],
    };

    handleReady(
      {
        type: "ready",
        model: "claude",
        currentProjectCwd: "/repo/a",
        tabs: [
          { id: "default", model: "claude", cwd: "/repo/a" },
          { id: "tab-2", model: "gpt", cwd: "/repo/a" },
        ],
      },
      ctx,
    );

    const tabOpenPayloads = harness.invoke.mock.calls
      .filter((call) => call[0] === "agent_command")
      .map((call) => JSON.parse(call[1].payload as string))
      .filter((payload) => payload.type === "tab_open");
    expect(tabOpenPayloads).toEqual([]);
  });

  it("does not replay shell tabs as bridge agent sessions after frontend reload", () => {
    const harness = installTauriMocks();
    const { ctx } = buildHandlerFixture({
      state: {
        activeTabId: "__overview__",
        tabs: [
          {
            id: "shell-1",
            kind: "shell",
            label: "Shell",
            messages: [],
            draft: "",
            waiting: false,
            queueCount: 0,
            queuedMessages: [],
            canvas: null,
            model: "",
            terminalBuffer: "",
            projectId: "p1",
            shell: {
              cwd: "/repo/a",
              command: "",
              args: [],
              shareMode: "private",
              shellState: "starting",
              restartOnMount: true,
            },
          },
        ],
      },
    });
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorktreeId: null,
      worktreesByProject: {},
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

    const tabOpenPayloads = harness.invoke.mock.calls
      .filter((call) => call[0] === "agent_command")
      .map((call) => JSON.parse(call[1].payload as string))
      .filter((payload) => payload.type === "tab_open");
    expect(tabOpenPayloads).toEqual([]);
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
