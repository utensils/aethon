import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSidebarResize,
  handleSidebarResizeEnd,
  handleSidebarRemoveProject,
  handleSidebarRemoveWorkspace,
  handleSidebarUnlockWorkspace,
  handleSidebarReorderWorkspace,
  handleSidebarSortProjectWorkspaces,
  handleSidebarDeleteSession,
  handleSidebarOpenWorkspaceInNewTab,
  handleSidebarRenameSession,
  handleSidebarSetProjectWorkspaceBase,
  handleSidebarStartSession,
  handleSidebarStopWorkspaceAgent,
  handleSidebarSwitchWorkspace,
  handleSidebarToggleExtension,
  handleSidebarRenameMobileDevice,
  handleSidebarRenameRemoteHost,
  handleSidebarReconnectRemoteHost,
  handleSidebarForgetRemoteHost,
  handleSidebarUnpairMobileDevice,
  handleSectionedSelect,
} from "./sidebar";
import { OVERVIEW_TAB_ID } from "../types/tab";
import { buildRouteFixture } from "./testFixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("handleSidebarResize", () => {
  it("rewrites just the leading column token", async () => {
    const { ctx, applySetState } = buildRouteFixture();
    const handled = await handleSidebarResize(
      {
        component: { id: "sidebar" },
        eventType: "resize",
        data: { width: 280 },
      },
      ctx,
    );
    expect(handled).toBe(true);
    const next = applySetState({
      layout: { columns: "220px minmax(0,1fr) 320px" },
    });
    expect((next.layout as { columns: string }).columns).toBe(
      "280px minmax(0,1fr) 320px",
    );
  });
});

describe("handleSectionedSelect remote host pairing", () => {
  it("uses the visible host code and invokes desktop pairing", async () => {
    const { ctx, mocks } = buildRouteFixture();

    const handled = await handleSectionedSelect(
      {
        component: { id: "sidebar", type: "sidebar" },
        eventType: "pair-remote-host",
        data: {
          sectionId: "hosts",
          itemId: "remote:bender",
          label: "bender",
          hostname: "aethon-123.local",
          fingerprint: "abcdef",
          candidates: ["aethon-123.local:38123"],
          code: "1234 5678",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("remote_host_pair", {
      host: "aethon-123.local:38123",
      fingerprint: "abcdef",
      code: "12345678",
      candidates: ["aethon-123.local:38123"],
    });
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "success", title: "Paired bender" }),
    );
  });

  it("keeps the prompt fallback for legacy pairing callers without a code", async () => {
    const promptSpy = vi.fn(() => "8765 4321");
    vi.stubGlobal("window", { prompt: promptSpy });
    const { ctx, mocks } = buildRouteFixture();

    const handled = await handleSectionedSelect(
      {
        component: { id: "sidebar", type: "sidebar" },
        eventType: "pair-remote-host",
        data: {
          sectionId: "hosts",
          itemId: "remote:bender",
          label: "bender",
          hostname: "aethon-123.local",
          fingerprint: "abcdef",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(promptSpy).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("remote_host_pair", {
      host: "aethon-123.local",
      fingerprint: "abcdef",
      code: "87654321",
      candidates: [],
    });
  });
});

describe("remote host context menu routes", () => {
  it("renames paired desktop hosts", async () => {
    const { ctx, mocks } = buildRouteFixture();

    const handled = await handleSidebarRenameRemoteHost(
      {
        component: { id: "sidebar", type: "sidebar" },
        eventType: "rename-remote-host",
        data: {
          itemId: "remote:bender",
          label: "Bender Lab",
          previousLabel: "bender",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("remote_host_rename", {
      id: "remote:bender",
      name: "Bender Lab",
    });
    await Promise.resolve();
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "success", title: "Host renamed" }),
    );
  });

  it("reconnects paired desktop hosts", async () => {
    const { ctx, mocks } = buildRouteFixture();

    const handled = await handleSidebarReconnectRemoteHost(
      {
        component: { id: "sidebar", type: "sidebar" },
        eventType: "reconnect-remote-host",
        data: { itemId: "remote:bender", label: "bender" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("remote_host_reconnect", {
      id: "remote:bender",
    });
    await Promise.resolve();
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "success",
        title: "Reconnect requested for bender",
      }),
    );
  });

  it("forgets paired desktop hosts and leaves active remote host", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { activeHostId: "remote:bender" },
    });

    const handled = await handleSidebarForgetRemoteHost(
      {
        component: { id: "sidebar", type: "sidebar" },
        eventType: "forget-remote-host",
        data: { itemId: "remote:bender", label: "bender" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("remote_host_forget", {
      id: "remote:bender",
    });
    await Promise.resolve();
    expect(ctx.setActiveHost).toHaveBeenCalledWith(null);
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "success", title: "Host forgotten" }),
    );
  });
});

describe("handleSidebarResizeEnd", () => {
  it("handles the drag lifecycle without a legacy one-off write", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { layout: { columns: "240px minmax(0,1fr)" } },
    });
    const handled = await handleSidebarResizeEnd(
      { component: { id: "sidebar" }, eventType: "resize-end" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.writeState).not.toHaveBeenCalled();
  });
});

describe("handleSidebarRemoveProject", () => {
  it("delegates to removeProjectById", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSidebarRemoveProject(
      {
        component: { id: "sidebar" },
        eventType: "remove-project",
        data: { projectId: "proj-1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.removeProjectById).toHaveBeenCalledWith("proj-1");
  });
});

describe("handleSidebarSetProjectWorkspaceBase", () => {
  it("delegates base branch changes to project ops", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleSidebarSetProjectWorkspaceBase(
      {
        component: { id: "sidebar" },
        eventType: "set-project-workspace-base",
        data: { projectId: "proj-1", baseBranch: "upstream/trunk" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.setProjectWorkspaceBaseBranch).toHaveBeenCalledWith(
      "proj-1",
      "upstream/trunk",
    );
  });
});

describe("handleSidebarRemoveWorkspace", () => {
  it("passes inline confirmation through to the project operation", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleSidebarRemoveWorkspace(
      {
        component: { id: "sidebar" },
        eventType: "remove-workspace",
        data: { workspaceId: "wt-1", confirmed: true },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.removeWorkspaceById).toHaveBeenCalledWith("wt-1", {
      confirmed: true,
    });
  });
});

describe("handleSidebarUnlockWorkspace", () => {
  it("delegates stale lock removal to the project operation", async () => {
    const { ctx } = buildRouteFixture();

    const handled = await handleSidebarUnlockWorkspace(
      {
        component: { id: "sidebar" },
        eventType: "unlock-workspace",
        data: { workspaceId: "wt-1" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(ctx.unlockWorkspaceById).toHaveBeenCalledWith("wt-1");
  });
});

describe("handleSidebarStopWorkspaceAgent", () => {
  it("stops running agent tabs in the selected workspace without switching focus", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        sidebar: {
          projects: [
            {
              id: "proj-1",
              workspaces: [{ id: "wt-1", path: "/repo/aethon-fix-issue" }],
            },
          ],
        },
        tabs: [],
        persistedTabBuckets: {
          "proj-1::workspace::wt-1": {
            tabs: [
              {
                id: "tab-bg",
                kind: "agent",
                cwd: "/repo/aethon-fix-issue",
                waiting: false,
              },
            ],
          },
        },
        agentRunningTabs: { "tab-bg": true },
      },
    });

    const handled = await handleSidebarStopWorkspaceAgent(
      {
        component: { id: "sidebar" },
        eventType: "stop-workspace-agent",
        data: { workspaceId: "wt-1" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.stopPrompt).toHaveBeenCalledWith("tab-bg");
    expect(mocks.activateWorkspace).not.toHaveBeenCalled();
    expect(mocks.setActiveProjectById).not.toHaveBeenCalled();
  });
});

describe("handleSidebarReorderWorkspace", () => {
  it("delegates manual workspace reordering to project ops", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSidebarReorderWorkspace(
      {
        component: { id: "sidebar" },
        eventType: "reorder-workspace",
        data: { projectId: "proj-1", workspaceId: "wt-1", toIndex: 0 },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.reorderWorkspace).toHaveBeenCalledWith("proj-1", "wt-1", 0);
  });
});

describe("handleSidebarSortProjectWorkspaces", () => {
  it("delegates newest-first sorting to project ops", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSidebarSortProjectWorkspaces(
      {
        component: { id: "sidebar" },
        eventType: "sort-project-workspaces",
        data: { projectId: "proj-1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.sortProjectWorkspacesNewest).toHaveBeenCalledWith("proj-1");
  });
});

describe("handleSidebarDeleteSession", () => {
  it("prompts then deletes when allowed", async () => {
    const { ctx, mocks } = buildRouteFixture({
      promptDeleteAllow: true,
      state: { tabs: [{ id: "sess-1", kind: "agent" }] },
    });
    await handleSidebarDeleteSession(
      {
        component: { id: "sidebar" },
        eventType: "delete-session",
        data: { sessionId: "sess-1", label: "Chat 1" },
      },
      ctx,
    );
    // Resolve the prompt promise + the delete_session invoke.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.invoke).toHaveBeenCalledWith("delete_session", {
      tabId: "sess-1",
    });
  });

  it("deletes and closes the default session when allowed", async () => {
    const { ctx, mocks } = buildRouteFixture({
      promptDeleteAllow: true,
      state: { tabs: [{ id: "default", kind: "agent" }] },
    });
    await handleSidebarDeleteSession(
      {
        component: { id: "sidebar" },
        eventType: "delete-session",
        data: { sessionId: "default", label: "Tab 1" },
      },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.invoke).toHaveBeenCalledWith("delete_session", {
      tabId: "default",
    });
    expect(mocks.closeTab).toHaveBeenCalledWith("default");
  });

  it("returns true and does nothing on empty input", async () => {
    const { ctx, mocks } = buildRouteFixture({ promptDeleteAllow: true });
    const handled = await handleSidebarDeleteSession(
      {
        component: { id: "sidebar" },
        eventType: "delete-session",
        data: {},
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.promptDeleteSessionConfirmation).not.toHaveBeenCalled();
  });
});

describe("handleSidebarRenameSession", () => {
  it("forwards a set_session_label command to the bridge", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        tabs: [{ id: "tab-7", kind: "agent", label: "Tab 1", cwd: "/repo/a" }],
      },
    });
    const handled = await handleSidebarRenameSession(
      {
        component: { id: "sidebar" },
        eventType: "rename-session",
        data: { sessionId: "tab-7", label: "Refactor pass" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "set_session_label",
        tabId: "tab-7",
        label: "Refactor pass",
        cwd: "/repo/a",
      }),
    });
  });

  it("trims cwd before forwarding a rename", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        tabs: [
          {
            id: "tab-spaced",
            kind: "agent",
            label: "Tab 1",
            cwd: "  /repo/spaced  ",
          },
        ],
      },
    });

    const handled = await handleSidebarRenameSession(
      {
        component: { id: "sidebar" },
        eventType: "rename-session",
        data: { sessionId: "tab-spaced", label: "Trimmed cwd" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "set_session_label",
        tabId: "tab-spaced",
        label: "Trimmed cwd",
        cwd: "/repo/spaced",
      }),
    });
  });

  it("includes the recent session cwd when renaming a closed session", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        tabs: [],
        recentSessions: [
          { id: "sess-closed", label: "Old name", cwd: "/repo/closed" },
        ],
      },
    });
    const handled = await handleSidebarRenameSession(
      {
        component: { id: "sidebar" },
        eventType: "rename-session",
        data: { sessionId: "sess-closed", label: "Manual name" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "set_session_label",
        tabId: "sess-closed",
        label: "Manual name",
        cwd: "/repo/closed",
      }),
    });
  });

  it("falls back to discovered session cwd when renaming a closed session", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { tabs: [] },
    });
    ctx.allDiscoveredSessionsRef.current = [
      { tabId: "sess-discovered", lastModified: 1, cwd: "/repo/discovered" },
    ];

    const handled = await handleSidebarRenameSession(
      {
        component: { id: "sidebar" },
        eventType: "rename-session",
        data: { sessionId: "sess-discovered", label: "Discovered name" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "set_session_label",
        tabId: "sess-discovered",
        label: "Discovered name",
        cwd: "/repo/discovered",
      }),
    });
  });

  it("optimistically updates an open tab's label so the rename is instant", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        tabs: [
          { id: "tab-7", kind: "agent", label: "Tab 1" },
          { id: "tab-9", kind: "agent", label: "Tab 2" },
        ],
      },
    });
    await handleSidebarRenameSession(
      {
        component: { id: "sidebar" },
        eventType: "rename-session",
        data: { sessionId: "tab-7", label: "Refactor pass" },
      },
      ctx,
    );
    const next = applySetState({
      tabs: [
        { id: "tab-7", kind: "agent", label: "Tab 1" },
        { id: "tab-9", kind: "agent", label: "Tab 2" },
      ],
    });
    const tabs = next.tabs as { id: string; label: string }[];
    expect(tabs[0].label).toBe("Refactor pass");
    expect(tabs[1].label).toBe("Tab 2");
  });

  it("empty label restores the auto sequential label for the open tab", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        tabs: [{ id: "tab-3", kind: "agent", label: "Custom name" }],
      },
    });
    await handleSidebarRenameSession(
      {
        component: { id: "sidebar" },
        eventType: "rename-session",
        data: { sessionId: "tab-3", label: "  " },
      },
      ctx,
    );
    const next = applySetState({
      tabs: [{ id: "tab-3", kind: "agent", label: "Custom name" }],
    });
    expect((next.tabs as { label: string }[])[0].label).toBe("Tab 1");
  });
});

describe("handleSidebarToggleExtension", () => {
  it("forwards a set_extension_disabled command to the bridge", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSidebarToggleExtension(
      {
        component: { id: "sidebar" },
        eventType: "toggle-extension",
        data: { name: "mold:image-gallery", disabled: true },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "set_extension_disabled",
        name: "mold:image-gallery",
        disabled: true,
      }),
    });
  });

  it("ignores non-toggle events for the sidebar", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSidebarToggleExtension(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { name: "x", disabled: true },
      },
      ctx,
    );
    expect(handled).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("handleSidebarSwitchWorkspace", () => {
  const sidebarState = {
    sidebar: {
      projects: [
        {
          id: "proj-1",
          label: "aethon",
          iconUrl: "asset://localhost/project-icons/aethon.png",
          workspaces: [
            {
              id: "wt-main",
              label: "main",
              branch: "main",
              path: "/repo/aethon",
              isMain: true,
            },
            {
              id: "wt-1",
              label: "fix/issue",
              branch: "fix/issue",
              path: "/repo/aethon-fix-issue",
              isMain: false,
            },
          ],
        },
      ],
    },
  };

  it("shows the landing when switching to an empty workspace scope", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        ...sidebarState,
        tabs: [{ id: "stale-tab", kind: "agent", cwd: "/repo/other" }],
        activeTabId: "stale-tab",
      },
    });
    mocks.activateWorkspace.mockImplementation(() => {
      ctx.stateRef.current = {
        ...ctx.stateRef.current,
        tabs: [],
        activeTabId: undefined,
      };
    });

    const handled = await handleSidebarSwitchWorkspace(
      {
        component: { id: "sidebar" },
        eventType: "switch-workspace",
        data: { workspaceId: "wt-1" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(ctx.activateWorkspace).toHaveBeenCalledWith("wt-1");
    const next = applySetState();
    expect(next.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(next.landing).toMatchObject({
      kind: "workspace",
      projectId: "proj-1",
      iconUrl: "asset://localhost/project-icons/aethon.png",
      workspaceId: "wt-1",
      path: "/repo/aethon-fix-issue",
    });
  });

  it("routes the expanded main workspace row through the project root scope", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        ...sidebarState,
        activeProjectId: "proj-2",
        activeWorkspaceId: "wt-other",
      },
    });

    const handled = await handleSidebarSwitchWorkspace(
      {
        component: { id: "sidebar" },
        eventType: "switch-workspace",
        data: { workspaceId: "wt-main" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.setActiveProjectById).toHaveBeenCalledWith("proj-1");
    expect(mocks.activateWorkspace).toHaveBeenCalledWith(null);
    expect(applySetState().landing).toMatchObject({
      kind: "workspace",
      projectId: "proj-1",
      workspaceId: "wt-main",
      isMain: true,
      path: "/repo/aethon",
    });
    expect(applySetState().activeTabId).toBe(OVERVIEW_TAB_ID);
  });

  it("routes visible inactive remote workspace rows through the remote host", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        activeHostId: "local:one",
        sidebar: {
          projects: [
            {
              id: "local-project",
              label: "local",
              workspaces: [{ id: "local-wt", path: "/repo/local" }],
            },
          ],
          projectsByHost: {
            "remote:bender": [
              {
                id: "remote:bender::project::nix",
                remoteId: "nix",
                hostId: "remote:bender",
                label: "nix",
                path: "/remote/nix",
                iconUrl: "data:image/png;base64,REMOTE",
                workspaces: [
                  {
                    id: "remote:bender::workspace::feature",
                    remoteId: "feature",
                    remoteProjectId: "nix",
                    projectId: "remote:bender::project::nix",
                    hostId: "remote:bender",
                    label: "feature",
                    branch: "feature",
                    path: "/remote/nix-feature",
                    isMain: false,
                  },
                ],
              },
            ],
          },
        },
      },
    });

    const handled = await handleSidebarSwitchWorkspace(
      {
        component: { id: "sidebar" },
        eventType: "switch-workspace",
        data: {
          workspaceId: "remote:bender::workspace::feature",
          projectId: "remote:bender::project::nix",
          hostId: "remote:bender",
          remoteId: "feature",
          remoteProjectId: "nix",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.activateWorkspace).not.toHaveBeenCalled();
    expect(ctx.setActiveHost).toHaveBeenCalledWith("remote:bender");
    const next = applySetState();
    expect(next.activeHostId).toBe("remote:bender");
    expect(next.activeProjectId).toBe("remote:bender::project::nix");
    expect(next.activeWorkspaceId).toBe("remote:bender::workspace::feature");
    expect(next.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(next.landing).toMatchObject({
      kind: "workspace",
      hostId: "remote:bender",
      projectId: "remote:bender::project::nix",
      workspaceId: "remote:bender::workspace::feature",
      path: "/remote/nix-feature",
      iconUrl: "data:image/png;base64,REMOTE",
    });
  });

  it("routes remote workspace rows from their click payload when derived mirrors are absent", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        activeHostId: "remote:3eb",
        sidebar: {
          projects: [],
        },
      },
    });

    const handled = await handleSidebarSwitchWorkspace(
      {
        component: { id: "sidebar" },
        eventType: "switch-workspace",
        data: {
          workspaceId: "remote:3eb::workspace::james-brink/fix-direnv",
          projectId: "remote:3eb::project::urandom",
          projectLabel: "urandom.io",
          projectPath: "/remote/urandom",
          hostId: "remote:3eb",
          remoteId: "james-brink/fix-direnv",
          remoteProjectId: "urandom",
          label: "james-brink/fix-direnv",
          path: "/remote/urandom-fix-direnv",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.activateWorkspace).not.toHaveBeenCalled();
    expect(ctx.setActiveHost).toHaveBeenCalledWith("remote:3eb");
    const next = applySetState();
    expect(next.activeHostId).toBe("remote:3eb");
    expect(next.activeProjectId).toBe("remote:3eb::project::urandom");
    expect(next.activeWorkspaceId).toBe(
      "remote:3eb::workspace::james-brink/fix-direnv",
    );
    expect(next.project).toMatchObject({
      id: "remote:3eb::project::urandom",
      remoteId: "urandom",
      hostId: "remote:3eb",
      label: "urandom.io",
      path: "/remote/urandom",
    });
    expect(next.landing).toMatchObject({
      kind: "workspace",
      hostId: "remote:3eb",
      projectId: "remote:3eb::project::urandom",
      projectLabel: "urandom.io",
      workspaceId: "remote:3eb::workspace::james-brink/fix-direnv",
      workspaceLabel: "james-brink/fix-direnv",
      path: "/remote/urandom-fix-direnv",
    });
  });

  it("derives raw remote project ids from qualified synthetic payloads", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        activeHostId: "remote:3eb",
        sidebar: { projects: [] },
      },
    });

    const handled = await handleSidebarSwitchWorkspace(
      {
        component: { id: "sidebar" },
        eventType: "switch-workspace",
        data: {
          workspaceId: "remote:3eb::workspace::james-brink/fix-direnv",
          projectId: "remote:3eb::project::urandom",
          projectLabel: "urandom.io",
          hostId: "remote:3eb",
          remoteId: "james-brink/fix-direnv",
          label: "james-brink/fix-direnv",
          path: "/remote/urandom-fix-direnv",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    const next = applySetState();
    expect(next.project).toMatchObject({
      id: "remote:3eb::project::urandom",
      remoteId: "urandom",
      label: "urandom.io",
    });
    expect(next.landing).toMatchObject({
      projectId: "remote:3eb::project::urandom",
      projectLabel: "urandom.io",
      workspaceId: "remote:3eb::workspace::james-brink/fix-direnv",
    });
  });

  it("opens visible remote workspaces in new tabs with host context", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        sidebar: {
          projectsByHost: {
            "remote:bender": [
              {
                id: "remote:bender::project::nix",
                remoteId: "nix",
                hostId: "remote:bender",
                label: "nix",
                path: "/remote/nix",
                workspaces: [
                  {
                    id: "remote:bender::workspace::feature",
                    remoteId: "feature",
                    remoteProjectId: "nix",
                    projectId: "remote:bender::project::nix",
                    hostId: "remote:bender",
                    label: "feature",
                    path: "/remote/nix-feature",
                    isMain: false,
                  },
                ],
              },
            ],
          },
        },
      },
    });

    const handled = await handleSidebarOpenWorkspaceInNewTab(
      {
        component: { id: "sidebar" },
        eventType: "open-workspace-in-new-tab",
        data: {
          workspaceId: "remote:bender::workspace::feature",
          projectId: "remote:bender::project::nix",
          hostId: "remote:bender",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.activateWorkspace).not.toHaveBeenCalled();
    expect(mocks.newTab).toHaveBeenCalledWith(undefined, undefined, {
      cwd: "/remote/nix-feature",
      hostId: "remote:bender",
    });
    expect(applySetState().landing).toBeNull();
  });

  it("does not open a remote tab without a cwd from synthetic payloads", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        activeHostId: "remote:3eb",
        sidebar: { projects: [] },
      },
    });

    const handled = await handleSidebarOpenWorkspaceInNewTab(
      {
        component: { id: "sidebar" },
        eventType: "open-workspace-in-new-tab",
        data: {
          workspaceId: "remote:3eb::workspace::feature",
          projectId: "remote:3eb::project::urandom",
          hostId: "remote:3eb",
          remoteId: "feature",
          label: "feature",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.newTab).not.toHaveBeenCalled();
    const next = applySetState();
    expect(next.activeWorkspaceId).toBe("remote:3eb::workspace::feature");
    expect(next.landing).toBeNull();
  });

  it("starts remote workspace landing sessions with host context", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        project: {
          id: "remote:bender::project::nix",
          remoteId: "nix",
          hostId: "remote:bender",
          label: "nix",
          path: "/remote/nix",
        },
        sidebar: {
          projectsByHost: {
            "remote:bender": [
              {
                id: "remote:bender::project::nix",
                remoteId: "nix",
                hostId: "remote:bender",
                label: "nix",
                path: "/remote/nix",
                workspaces: [
                  {
                    id: "remote:bender::workspace::feature",
                    remoteId: "feature",
                    remoteProjectId: "nix",
                    projectId: "remote:bender::project::nix",
                    hostId: "remote:bender",
                    label: "feature",
                    path: "/remote/nix-feature",
                    isMain: false,
                  },
                ],
              },
            ],
          },
        },
      },
    });

    const handled = await handleSidebarStartSession(
      {
        component: { id: "workspace-landing" },
        eventType: "start-session",
        data: {
          workspaceId: "remote:bender::workspace::feature",
          projectId: "remote:bender::project::nix",
          hostId: "remote:bender",
          path: "/remote/nix-feature",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.activateWorkspace).not.toHaveBeenCalled();
    expect(ctx.setActiveHost).toHaveBeenCalledWith("remote:bender");
    expect(mocks.newTab).toHaveBeenCalledWith(undefined, undefined, {
      cwd: "/remote/nix-feature",
      hostId: "remote:bender",
    });
    expect(applySetState().landing).toBeNull();
  });

  it("reveals an existing workspace session instead of covering it with landing", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: sidebarState,
    });
    mocks.activateWorkspace.mockImplementation(() => {
      ctx.stateRef.current = {
        ...ctx.stateRef.current,
        tabs: [{ id: "tab-1", kind: "agent", cwd: "/repo/aethon-fix-issue" }],
        activeTabId: "tab-1",
      };
    });

    const handled = await handleSidebarSwitchWorkspace(
      {
        component: { id: "sidebar" },
        eventType: "switch-workspace",
        data: { workspaceId: "wt-1" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(applySetState().landing).toBeNull();
  });

  it("re-clicking the already-active workspace returns to the landing overview", async () => {
    // Starting state: workspace wt-1 is active with an agent session on
    // top. Clicking wt-1 again is the user's "back to the workspace
    // landing" gesture — rebuild the landing AND deselect the session
    // tab via the overview sentinel so the landing actually renders.
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        ...sidebarState,
        activeWorkspaceId: "wt-1",
        tabs: [{ id: "tab-1", kind: "agent", cwd: "/repo/aethon-fix-issue" }],
        activeTabId: "tab-1",
      },
    });

    const handled = await handleSidebarSwitchWorkspace(
      {
        component: { id: "sidebar" },
        eventType: "switch-workspace",
        data: { workspaceId: "wt-1" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.activateWorkspace).toHaveBeenCalledWith("wt-1");
    const next = applySetState({
      activeWorkspaceId: "wt-1",
      tabs: [{ id: "tab-1", kind: "agent", cwd: "/repo/aethon-fix-issue" }],
      activeTabId: "tab-1",
    });
    expect(next.landing).toMatchObject({
      kind: "workspace",
      workspaceId: "wt-1",
    });
    expect(next.activeTabId).toBe(OVERVIEW_TAB_ID);
  });
});

describe("handleSectionedSelect", () => {
  it("toggle-terminal hits toggleTerminal", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { itemId: "toggle-terminal" },
      },
      ctx,
    );
    expect(mocks.toggleTerminal).toHaveBeenCalledTimes(1);
  });

  it("models section calls setModel", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleSectionedSelect(
      {
        component: { id: "model-picker" },
        eventType: "select",
        data: { sectionId: "models", itemId: "anthropic/claude-opus-4-7" },
      },
      ctx,
    );
    expect(mocks.setModel).toHaveBeenCalledWith("anthropic/claude-opus-4-7");
  });

  it("themes section calls setTheme", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleSectionedSelect(
      {
        component: { id: "appearance-menu" },
        eventType: "select",
        data: { sectionId: "themes", itemId: "dim" },
      },
      ctx,
    );
    expect(mocks.setTheme).toHaveBeenCalledWith("dim");
  });

  it("history section with tab: prefix activates that tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "history", itemId: "tab:abc123" },
      },
      ctx,
    );
    expect(mocks.setActiveTab).toHaveBeenCalledWith("abc123");
  });

  it("hosts section selects the host overview and clears project context", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        activeHostId: "local:one",
        activeProjectId: "proj-1",
        activeWorkspaceId: "wt-1",
        activeTabId: "tab-7",
        project: { id: "proj-1", hostId: "local:one" },
      },
    });
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "hosts", itemId: "remote:bender" },
      },
      ctx,
    );
    const next = applySetState();
    expect(ctx.setActiveHost).toHaveBeenCalledWith("remote:bender");
    expect(ctx.activateWorkspace).toHaveBeenCalledWith(null);
    expect(ctx.clearActiveProject).toHaveBeenCalled();
    expect(next).toMatchObject({
      activeHostId: "remote:bender",
      activeTabId: OVERVIEW_TAB_ID,
      activeProjectId: null,
      activeWorkspaceId: null,
      project: null,
      landing: null,
    });
  });

  it("mobile devices section selects the device detail view", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: { activeTabId: "tab-7", landing: null },
    });
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: {
          sectionId: "mobile-devices",
          itemId: "device:dev-iphone",
          label: "James's iPhone",
          platform: "ios",
          status: "connected",
          paired: true,
          connected: true,
          createdAt: 1_000,
          lastSeenAt: 2_000,
        },
      },
      ctx,
    );

    expect(applySetState().activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(applySetState().landing).toMatchObject({
      kind: "mobile-device",
      deviceId: "device:dev-iphone",
      label: "James's iPhone",
      platform: "ios",
      status: "Connected",
      paired: true,
      connected: true,
      createdAt: 1_000,
      lastSeenAt: 2_000,
    });
  });

  it("unpair-mobile-device revokes the raw device id and clears its landing", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        landing: { kind: "mobile-device", deviceId: "device:dev-iphone" },
      },
    });
    const handled = await handleSidebarUnpairMobileDevice(
      {
        component: { id: "sidebar" },
        eventType: "unpair-mobile-device",
        data: {
          sectionId: "mobile-devices",
          itemId: "device:dev-iphone",
          label: "James's iPhone",
        },
      },
      ctx,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("remote_device_revoke", {
      id: "dev-iphone",
    });
    expect(applySetState().landing).toBeNull();
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Device unpaired",
        message: "James's iPhone",
        kind: "success",
      }),
    );
  });

  it("rename-mobile-device persists the raw device id and updates the landing", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        landing: {
          kind: "mobile-device",
          deviceId: "device:dev-iphone",
          label: "iPhone",
        },
        sidebar: {
          mobileDevices: [
            {
              id: "device:dev-iphone",
              label: "iPhone",
            },
          ],
        },
      },
    });
    const handled = await handleSidebarRenameMobileDevice(
      {
        component: { id: "sidebar" },
        eventType: "rename-mobile-device",
        data: {
          sectionId: "mobile-devices",
          itemId: "device:dev-iphone",
          label: "Pocket Aethon",
          previousLabel: "iPhone",
        },
      },
      ctx,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("remote_device_rename", {
      id: "dev-iphone",
      name: "Pocket Aethon",
    });
    expect(applySetState().landing).toMatchObject({
      kind: "mobile-device",
      deviceId: "device:dev-iphone",
      label: "Pocket Aethon",
    });
    expect(
      (
        applySetState().sidebar as {
          mobileDevices: Array<{ id: string; label: string }>;
        }
      ).mobileDevices[0],
    ).toMatchObject({ label: "Pocket Aethon" });
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Device renamed",
        message: "Pocket Aethon",
        kind: "success",
      }),
    );
  });

  it("projects open-project triggers the picker", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "projects", itemId: "open-project" },
      },
      ctx,
    );
    expect(mocks.openProjectFromPicker).toHaveBeenCalledTimes(1);
  });

  it("projects section selects the main project and clears workspace landing", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        landing: {
          kind: "workspace",
          projectId: "proj-1",
          workspaceId: "wt-1",
        },
      },
    });
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "projects", itemId: "proj-1" },
      },
      ctx,
    );
    expect(ctx.activateWorkspace).toHaveBeenCalledWith(null);
    expect(mocks.setActiveProjectById).toHaveBeenCalledWith("proj-1");
    expect(applySetState().landing).toBeNull();
  });

  it("returns false for non-select events", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleSectionedSelect(
      { component: { id: "sidebar" }, eventType: "click" },
      ctx,
    );
    expect(handled).toBe(false);
  });

  it("re-clicking the active project returns to overview", async () => {
    // First click on a project already-active is the user's "back to
    // project overview" gesture. The session tab stays in /tabs; only
    // the activeTabId moves to the overview sentinel so the dashboard
    // takes the canvas.
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        project: { id: "proj-1", path: "/repo/app" },
        activeTabId: "tab-7",
      },
    });
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "projects", itemId: "proj-1" },
      },
      ctx,
    );
    const next = applySetState({
      project: { id: "proj-1", path: "/repo/app" },
      activeTabId: "tab-7",
    });
    expect(next.activeTabId).toBe(OVERVIEW_TAB_ID);
  });

  it("clicking the active project from a workspace restores main without forcing overview", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        project: { id: "proj-1", path: "/repo/app" },
        activeWorkspaceId: "wt-1",
        activeTabId: "main-tab",
      },
    });
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "projects", itemId: "proj-1" },
      },
      ctx,
    );
    const next = applySetState({
      project: { id: "proj-1", path: "/repo/app" },
      activeWorkspaceId: "wt-1",
      activeTabId: "main-tab",
    });
    expect(next.activeTabId).toBe("main-tab");
  });

  it("clicking a different project does NOT force the overview sentinel", async () => {
    // Project switching has bucket logic in setActiveProjectById; the
    // re-click gesture must not stomp on a target-bucket activeTabId.
    const { ctx, applySetState } = buildRouteFixture({
      state: {
        project: { id: "proj-1" },
        activeTabId: "tab-7",
      },
    });
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "projects", itemId: "proj-2" },
      },
      ctx,
    );
    const next = applySetState({
      project: { id: "proj-1" },
      activeTabId: "tab-7",
    });
    expect(next.activeTabId).toBe("tab-7");
  });

  it("re-clicking the active host returns to overview", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: { activeHostId: "remote:bender", activeTabId: "tab-7" },
    });
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "hosts", itemId: "remote:bender" },
      },
      ctx,
    );
    const next = applySetState({
      activeHostId: "remote:bender",
      activeTabId: "tab-7",
    });
    expect(next.activeTabId).toBe(OVERVIEW_TAB_ID);
  });

  it("clicking a different host opens that host overview", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: { activeHostId: "local:one", activeTabId: "tab-7" },
    });
    await handleSectionedSelect(
      {
        component: { id: "sidebar" },
        eventType: "select",
        data: { sectionId: "hosts", itemId: "remote:bender" },
      },
      ctx,
    );
    const next = applySetState({
      activeHostId: "local:one",
      activeTabId: "tab-7",
    });
    expect(next.activeTabId).toBe(OVERVIEW_TAB_ID);
  });
});
