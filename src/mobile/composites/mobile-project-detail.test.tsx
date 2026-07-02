// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileProjectDetail } from "./mobile-project-detail";

afterEach(cleanup);

describe("MobileProjectDetail", () => {
  it("renders project overview, workspaces, issues, and recent sessions", () => {
    const onEvent = vi.fn();
    render(
      <MobileProjectDetail
        component={{ id: "detail", type: "mobile-project-detail" }}
        state={{
          activeProjectId: "p1",
          activeWorkspaceId: "wt-1",
          sidebar: {
            projects: [
              {
                id: "p1",
                label: "aethon",
                path: "/Users/jamesbrink/Projects/aethon",
                workspaces: [
                  {
                    id: "main",
                    label: "Main",
                    path: "/Users/jamesbrink/Projects/aethon",
                    isMain: true,
                  },
                  {
                    id: "wt-1",
                    label: "fix/mobile",
                    branch: "fix/mobile",
                    path: "/Users/jamesbrink/Projects/aethon-mobile",
                    active: true,
                  },
                ],
              },
            ],
          },
          projectDashboard: {
            recentSessions: [
              {
                id: "s1",
                label: "Layout polish",
                cwd: "/Users/jamesbrink/Projects/aethon-mobile",
              },
            ],
          },
          vcs: {
            root: "/Users/jamesbrink/Projects/aethon-mobile",
            branch: "fix/mobile",
            dirty: true,
            changes: { total: 3, files: [] },
            pr: { number: 42, title: "Mobile layout", state: "OPEN" },
            ci: { conclusion: "success", total: 5, passed: 5 },
          },
        }}
        onEvent={onEvent}
      />,
    );

    expect(screen.getByRole("heading", { name: "aethon" })).toBeDefined();
    expect(screen.getAllByText("fix/mobile").length).toBeGreaterThan(0);
    expect(screen.getByText("Working tree")).toBeDefined();
    expect(screen.getByText("3 changed")).toBeDefined();
    expect(screen.getByText("Layout polish")).toBeDefined();

    fireEvent.click(screen.getAllByRole("button", { name: "Chat" })[1]);
    expect(onEvent).toHaveBeenCalledWith("start-session", {
      projectId: "p1",
      workspaceId: "wt-1",
      path: "/Users/jamesbrink/Projects/aethon-mobile",
    });
  });

  it("opens project tools from the action row", () => {
    const onEvent = vi.fn();
    render(
      <MobileProjectDetail
        component={{ id: "detail", type: "mobile-project-detail" }}
        state={{
          activeProjectId: "p1",
          sidebar: {
            projects: [
              {
                id: "p1",
                label: "aethon",
                path: "/repo/aethon",
              },
            ],
          },
        }}
        onEvent={onEvent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Git" }).at(-1)!);

    expect(onEvent).toHaveBeenCalledWith("open-screen", { screen: "files" });
    expect(onEvent).toHaveBeenCalledWith("open-screen", { screen: "terminal" });
    expect(onEvent).toHaveBeenCalledWith("open-screen", { screen: "git" });
  });
});
