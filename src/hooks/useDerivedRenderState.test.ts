// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeEmptyTab } from "../types/tab";
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
    expect(buildSidebarHistory).toHaveBeenCalledWith(
      [active],
      "tab-1",
      [],
    );
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
});
