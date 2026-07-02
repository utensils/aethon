// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OVERVIEW_TAB_ID, makeEmptyTab } from "../types/tab";
import { useDerivedRenderState } from "./useDerivedRenderState";
import type { UseHostInfo } from "./useHostInfo";

const hostInfo: UseHostInfo = {
  activeHostId: "local:one",
  localHostId: "local:one",
  setActiveHost: vi.fn(),
  mobileDevices: [],
  hosts: [
    {
      id: "local:one",
      hostname: "aethon.local",
      displayName: "Aethon",
      isLocal: true,
    },
  ],
};

describe("useDerivedRenderState", () => {
  it("derives tab visibility gates from the active tab kind", () => {
    const active = makeEmptyTab("tab-1", "Tab 1");
    const buildSidebarHistory = vi.fn(() => [{ id: "tab-1", label: "Tab 1" }]);
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [active],
          activeTabId: "tab-1",
          sidebar: {},
          notifications: [{ id: "n1" }],
          palette: { open: true },
        },
        buildSidebarHistory,
        hostInfo,
      }),
    );

    expect(result.current.renderState.hasTabs).toBe(true);
    expect(result.current.renderState.empty).toBe(false);
    expect(result.current.renderState.agentTabActive).toBe(true);
    expect(result.current.renderState.shellTabActive).toBe(false);
    expect(result.current.notificationsOpen).toBe(true);
    expect(result.current.paletteOpen).toBe(true);
    expect(result.current.renderState.sidebar).toMatchObject({
      history: [{ id: "tab-1", label: "Tab 1" }],
      hosts: [
        {
          id: "local:one",
          label: "Aethon",
          hint: "this mac",
          active: true,
        },
      ],
    });
    expect(buildSidebarHistory).toHaveBeenCalledWith([active], "tab-1", []);
  });

  it("keeps the overview visible when only shell tabs exist", () => {
    // The shell tab lives in /tabs (for terminal-panel routing) but
    // must not own the canvas — the host / project dashboard should
    // still show. Regression for the "opening console wipes overview"
    // bug.
    const shell = makeEmptyTab("sh-1", "Shell 1", null, "shell");
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [shell],
          activeTabId: OVERVIEW_TAB_ID,
          sidebar: {},
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );

    expect(result.current.renderState.hasTabs).toBe(true);
    expect(result.current.renderState.hasSessionTabs).toBe(false);
    expect(result.current.renderState.overviewActive).toBe(true);
    expect(result.current.renderState.empty).toBe(true);
    expect(result.current.renderState.agentTabActive).toBe(false);
    expect(result.current.renderState.shellTabActive).toBe(false);
    expect(result.current.renderState.emptyAndNoProject).toBe(true);
  });

  it("keeps overview visible when activeTabId points at a shell tab", () => {
    const shell = makeEmptyTab("sh-1", "Shell 1", null, "shell");
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [shell],
          activeTabId: "sh-1",
          project: { id: "p1", path: "/repo/app" },
          sidebar: {},
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );

    expect(result.current.renderState.hasTabs).toBe(true);
    expect(result.current.renderState.hasSessionTabs).toBe(false);
    expect(result.current.renderState.overviewActive).toBe(true);
    expect(result.current.renderState.empty).toBe(true);
    expect(result.current.renderState.emptyAndProject).toBe(true);
    expect(result.current.renderState.agentTabActive).toBe(false);
    expect(result.current.renderState.shellTabActive).toBe(false);
    expect(result.current.renderState.editorTabActive).toBe(false);
  });

  it("keeps the overview visible when an agent tab exists but the overview pill is active", () => {
    // User has a session in /tabs but clicked the overview pill to
    // return to the project dashboard without closing the tab.
    const agent = makeEmptyTab("agent-1", "Tab 1");
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [agent],
          activeTabId: OVERVIEW_TAB_ID,
          project: { id: "p1", path: "/repo/app" },
          sidebar: {},
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );

    expect(result.current.renderState.hasSessionTabs).toBe(true);
    expect(result.current.renderState.overviewActive).toBe(true);
    expect(result.current.renderState.empty).toBe(true);
    expect(result.current.renderState.emptyAndProject).toBe(true);
    expect(result.current.renderState.agentTabActive).toBe(false);
  });

  it("treats undefined activeTabId as overview-active", () => {
    // Boot / persistence-miss case: state arrives with no activeTabId.
    // The overview should own the canvas rather than rendering a
    // phantom session view.
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [],
          activeTabId: undefined,
          sidebar: {},
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );

    expect(result.current.renderState.overviewActive).toBe(true);
    expect(result.current.renderState.empty).toBe(true);
    expect(result.current.renderState.emptyAndNoProject).toBe(true);
    expect(result.current.renderState.overviewTabId).toBe(OVERVIEW_TAB_ID);
  });

  it("flags overviewActive false while a real agent tab is selected", () => {
    const agent = makeEmptyTab("agent-1", "Tab 1");
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [agent],
          activeTabId: "agent-1",
          sidebar: {},
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );

    expect(result.current.renderState.overviewActive).toBe(false);
    expect(result.current.renderState.empty).toBe(false);
    expect(result.current.renderState.agentTabActive).toBe(true);
  });

  it("does not expose a selected session tab while workspace landing owns the canvas", () => {
    const agent = makeEmptyTab("agent-1", "Tab 1");
    const buildSidebarHistory = vi.fn(
      (_tabs, activeId) =>
        [
          {
            id: "agent-1",
            label: "Tab 1",
            active: activeId === "agent-1",
          },
        ],
    );
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [agent],
          activeTabId: "agent-1",
          landing: { kind: "workspace", workspaceId: "wt-1" },
          sidebar: {},
        },
        buildSidebarHistory,
        hostInfo,
      }),
    );

    expect(result.current.renderState.landingVisible).toBe(true);
    expect(result.current.renderState.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(result.current.renderState.overviewActive).toBe(true);
    expect(result.current.renderState.agentTabActive).toBe(false);
    expect(buildSidebarHistory).toHaveBeenCalledWith(
      [agent],
      OVERVIEW_TAB_ID,
      [],
    );
    expect(result.current.renderState.sidebar).toMatchObject({
      history: [{ id: "agent-1", active: false }],
    });
  });

  it("makes a selected mobile device own the overview canvas", () => {
    const buildSidebarHistory = vi.fn(() => []);
    const mobileHostInfo: UseHostInfo = {
      ...hostInfo,
      mobileDevices: [
        {
          id: "device:dev-iphone",
          hostname: "ios",
          displayName: "iPhone",
          isLocal: false,
          paired: true,
          connected: true,
          createdAt: 1,
          lastSeen: 2,
        },
      ],
    };
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [],
          activeTabId: OVERVIEW_TAB_ID,
          landing: { kind: "mobile-device", deviceId: "device:dev-iphone" },
          sidebar: {},
        },
        buildSidebarHistory,
        hostInfo: mobileHostInfo,
      }),
    );

    expect(result.current.renderState.landingVisible).toBe(true);
    expect(result.current.renderState.workspaceLandingVisible).toBe(false);
    expect(result.current.renderState.mobileDeviceLandingVisible).toBe(true);
    expect(result.current.renderState.emptyAndNoProject).toBe(false);
    const sidebar = result.current.renderState.sidebar as {
      mobileDevices?: unknown[];
    };
    expect(sidebar.mobileDevices).toMatchObject([
      {
        id: "device:dev-iphone",
        label: "iPhone",
        platform: "ios",
        hint: "connected",
        active: true,
        connected: true,
        paired: true,
        createdAt: 1,
        lastSeenAt: 2,
      },
    ]);
  });

  it("synthesizes workspace landing when active workspace state loses its landing object", () => {
    const buildSidebarHistory = vi.fn(() => []);
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [],
          activeTabId: OVERVIEW_TAB_ID,
          activeProjectId: "p1",
          activeWorkspaceId: "wt-1",
          project: { id: "p1", path: "/repo/app" },
          landing: null,
          sidebar: {
            projects: [
              {
                id: "p1",
                label: "Aethon",
                iconUrl: "asset://localhost/icon.png",
                workspaces: [
                  {
                    id: "wt-1",
                    label: "fix/session",
                    branch: "fix/session",
                    path: "/repo/app-fix-session",
                    isMain: false,
                  },
                ],
              },
            ],
          },
        },
        buildSidebarHistory,
        hostInfo,
      }),
    );

    expect(result.current.renderState.landingVisible).toBe(true);
    expect(result.current.renderState.emptyAndProject).toBe(false);
    expect(result.current.renderState.landing).toMatchObject({
      kind: "workspace",
      projectId: "p1",
      projectLabel: "Aethon",
      workspaceId: "wt-1",
      branch: "fix/session",
      path: "/repo/app-fix-session",
    });
    expect(buildSidebarHistory).toHaveBeenCalledWith([], OVERVIEW_TAB_ID, []);
  });

  it("builds the active project dashboard from matching sessions and workspaces", () => {
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [],
          activeTabId: null,
          project: { id: "p1", path: "/repo/app" },
          projects: [{ id: "p1" }, { id: "p2" }],
          sidebar: {
            projects: [
              {
                id: "p1",
                workspaces: [{ id: "wt-1", path: "/repo/app-fix" }],
              },
            ],
          },
          recentSessions: [
            { id: "s1", cwd: "/repo/app/" },
            { id: "s2", cwd: "/repo/other" },
          ],
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );

    expect(result.current.renderState.emptyAndProject).toBe(true);
    expect(result.current.renderState.projectDashboard).toMatchObject({
      otherProjects: [{ id: "p2" }],
      workspaces: [{ id: "wt-1", path: "/repo/app-fix" }],
      recentSessions: [{ id: "s1", cwd: "/repo/app/" }],
      widgets: [],
    });
  });

  it("keeps workspace sessions visible on the project dashboard", () => {
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [],
          activeTabId: OVERVIEW_TAB_ID,
          project: { id: "p1", path: "/repo/app" },
          projects: [{ id: "p1" }],
          sidebar: {
            projects: [
              {
                id: "p1",
                workspaces: [{ id: "wt-1", path: "/repo/app-fix" }],
              },
            ],
          },
          recentSessions: [
            { id: "main", cwd: "/repo/app" },
            { id: "workspace", cwd: "/repo/app-fix/" },
            { id: "other", cwd: "/repo/other" },
          ],
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );

    expect(result.current.renderState.projectDashboard).toMatchObject({
      recentSessions: [
        { id: "main", cwd: "/repo/app" },
        { id: "workspace", cwd: "/repo/app-fix/" },
      ],
    });
  });

  it("overlays agent-activity across the active tabs and stashed buckets", () => {
    const mainTab = {
      ...makeEmptyTab("m", "m", "p1", "agent"),
      cwd: "/repo/app",
    };
    // Background workspace session lives in a stashed bucket (mirrored into
    // state.persistedTabBuckets), not state.tabs.
    const bgTab = {
      ...makeEmptyTab("w", "w", "p1", "agent"),
      cwd: "/repo/app-fix",
    };
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [mainTab],
          activeTabId: "m",
          // bucket-independent running set: host + background workspace turns.
          agentRunningTabs: { m: true, w: true },
          persistedTabBuckets: {
            "p1::workspace::wt-1": { tabs: [bgTab], activeTabId: "w" },
          },
          sidebar: {
            projects: [
              {
                id: "p1",
                workspaces: [
                  { id: "wt-main", path: "/repo/app", isMain: true },
                  { id: "wt-1", path: "/repo/app-fix" },
                ],
              },
            ],
          },
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );

    const projects = (
      result.current.renderState.sidebar as {
        projects: {
          agent: { status: string };
          agentRollup: { status: string };
          workspaces: {
            id: string;
            agent?: { status: string; runningCount: number };
          }[];
        }[];
      }
    ).projects;
    // Main scope sees the host workspace turn.
    expect(projects[0].agent.status).toBe("running");
    // The workspace row reports "running" even though its tab is stashed —
    // liveness comes from the running set, not the bucket's stale waiting.
    const wt1 = projects[0].workspaces.find((w) => w.id === "wt-1");
    expect(wt1?.agent?.status).toBe("running");
    // Rollup is running (a workspace turn is in flight).
    expect(projects[0].agentRollup.status).toBe("running");
    // The main workspace row mirrors host-session activity, matching worktree rows.
    const wtMain = projects[0].workspaces.find((w) => w.id === "wt-main");
    expect(wtMain?.agent?.status).toBe("running");
    expect(wtMain?.agent?.runningCount).toBe(1);
  });

  it("overlays completed background agent attention across stashed buckets", () => {
    const visibleTab = {
      ...makeEmptyTab("visible", "visible", "p2", "agent"),
      cwd: "/repo/other",
    };
    const hiddenDone = {
      ...makeEmptyTab("done", "done", "p1", "agent"),
      cwd: "/repo/app-fix",
    };
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [visibleTab],
          activeTabId: "visible",
          agentAttentionTabs: { done: true },
          persistedTabBuckets: {
            "p1::workspace::wt-1": { tabs: [hiddenDone], activeTabId: "done" },
          },
          sidebar: {
            projects: [
              {
                id: "p1",
                workspaces: [
                  { id: "wt-main", path: "/repo/app", isMain: true },
                  { id: "wt-1", path: "/repo/app-fix" },
                ],
              },
              {
                id: "p2",
                workspaces: [
                  { id: "wt-main-2", path: "/repo/other", isMain: true },
                ],
              },
            ],
          },
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );

    const projects = (
      result.current.renderState.sidebar as {
        projects: {
          id: string;
          agentRollup: { status: string };
          workspaces: { id: string; agent?: { status: string } }[];
        }[];
      }
    ).projects;
    const nxvLike = projects.find((p) => p.id === "p1");
    expect(nxvLike?.agentRollup.status).toBe("needs-attention");
    expect(
      nxvLike?.workspaces.find((w) => w.id === "wt-1")?.agent?.status,
    ).toBe("needs-attention");
  });

  it("keeps sidebar activity running until a terminal turn event clears it", () => {
    // `waiting` can briefly drift false while the agent is still streaming
    // tool output. The running set owns lifecycle until response_end,
    // explicit stop, or crash removes the tab id.
    const idleActive = {
      ...makeEmptyTab("m", "m", "p1", "agent"),
      cwd: "/repo/app",
      waiting: false,
    };
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [idleActive],
          activeTabId: "m",
          agentRunningTabs: { m: true },
          sidebar: {
            projects: [
              {
                id: "p1",
                workspaces: [
                  { id: "wt-main", path: "/repo/app", isMain: true },
                ],
              },
            ],
          },
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );
    const projects = (
      result.current.renderState.sidebar as {
        projects: { agent: { status: string } }[];
      }
    ).projects;
    expect(projects[0].agent.status).toBe("running");
  });

  it("keeps sidebar activity running while a visible tool-card is still live", () => {
    const activeWithRunningTool = {
      ...makeEmptyTab("m", "m", "p1", "agent"),
      cwd: "/repo/app",
      waiting: false,
      messages: [
        {
          id: "tool-message",
          role: "agent" as const,
          a2ui: {
            components: [
              {
                id: "tool-1",
                type: "tool-card",
                props: { title: "bash", startedAt: 1_000 },
              },
            ],
          },
        },
      ],
    };
    const { result } = renderHook(() =>
      useDerivedRenderState({
        state: {
          tabs: [activeWithRunningTool],
          activeTabId: "m",
          agentRunningTabs: { m: true },
          sidebar: {
            projects: [
              {
                id: "p1",
                workspaces: [
                  { id: "wt-main", path: "/repo/app", isMain: true },
                ],
              },
            ],
          },
        },
        buildSidebarHistory: vi.fn(() => []),
        hostInfo,
      }),
    );
    const projects = (
      result.current.renderState.sidebar as {
        projects: {
          agent: { status: string };
          agentRollup: { status: string };
        }[];
      }
    ).projects;
    expect(projects[0].agent.status).toBe("running");
    expect(projects[0].agentRollup.status).toBe("running");
  });
});
