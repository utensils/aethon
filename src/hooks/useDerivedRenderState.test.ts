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

  it("builds the active project dashboard from matching sessions and worktrees", () => {
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
                worktrees: [{ id: "wt-1", path: "/repo/app-fix" }],
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
      worktrees: [{ id: "wt-1", path: "/repo/app-fix" }],
      recentSessions: [{ id: "s1", cwd: "/repo/app/" }],
      widgets: [],
    });
  });

  it("overlays agent-activity across the active tabs and stashed buckets", () => {
    const mainTab = {
      ...makeEmptyTab("m", "m", "p1", "agent"),
      cwd: "/repo/app",
    };
    // Background worktree session lives in a stashed bucket (mirrored into
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
          // bucket-independent running set: the backgrounded worktree turn.
          agentRunningTabs: { w: true },
          persistedTabBuckets: {
            "p1::worktree::wt-1": { tabs: [bgTab], activeTabId: "w" },
          },
          sidebar: {
            projects: [
              {
                id: "p1",
                worktrees: [
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
          worktrees: { id: string; agent?: { status: string } }[];
        }[];
      }
    ).projects;
    // Main scope has an idle session (mainTab is not running).
    expect(projects[0].agent.status).toBe("idle-with-session");
    // The worktree row reports "running" even though its tab is stashed —
    // liveness comes from the running set, not the bucket's stale waiting.
    const wt1 = projects[0].worktrees.find((w) => w.id === "wt-1");
    expect(wt1?.agent?.status).toBe("running");
    // Rollup is running (a worktree turn is in flight).
    expect(projects[0].agentRollup.status).toBe("running");
    // The main worktree row stays dot-free (activity shown on project line).
    const wtMain = projects[0].worktrees.find((w) => w.id === "wt-main");
    expect(wtMain && "agent" in wtMain).toBe(false);
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
                worktrees: [{ id: "wt-main", path: "/repo/app", isMain: true }],
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
                worktrees: [{ id: "wt-main", path: "/repo/app", isMain: true }],
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
