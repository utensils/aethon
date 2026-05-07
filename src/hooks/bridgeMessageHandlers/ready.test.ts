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
});

// Quiet the ESLint vi-unused warning when fake timers aren't used.
void vi;
