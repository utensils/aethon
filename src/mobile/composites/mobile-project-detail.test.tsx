// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const issueCache = vi.hoisted(() => ({
  refreshIssues: vi.fn(),
  getIssueDetail: vi.fn(),
}));

const tauriApi = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("../../ghIssuesCache", () => issueCache);
vi.mock("@tauri-apps/api/core", () => tauriApi);

import { MobileProjectDetail } from "./mobile-project-detail";

beforeEach(() => {
  issueCache.refreshIssues.mockResolvedValue([]);
  issueCache.getIssueDetail.mockResolvedValue({
    number: 33,
    title: "Fix mobile issue rendering",
    url: "https://github.com/example/aethon/issues/33",
    body: "Issue body",
    author: "jamesbrink",
  });
  tauriApi.invoke.mockResolvedValue({ templates: [], warning: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

  it("renders GitHub issues and dispatches one to the agent", async () => {
    const onEvent = vi.fn();
    issueCache.refreshIssues.mockResolvedValue([
      {
        number: 33,
        title: "Fix mobile issue rendering",
        url: "https://github.com/example/aethon/issues/33",
        state: "OPEN",
        labels: [{ name: "bug", color: "ff5c5c" }],
        updatedAt: "2026-07-02T12:00:00Z",
        author: "jamesbrink",
        comments: 2,
      },
    ]);

    render(
      <MobileProjectDetail
        component={{ id: "detail", type: "mobile-project-detail" }}
        state={{
          activeProjectId: "p1",
          activeWorkspaceId: "main",
          sidebar: {
            projects: [
              {
                id: "p1",
                label: "aethon",
                path: "/repo/aethon",
                workspaces: [
                  {
                    id: "main",
                    label: "Main",
                    path: "/repo/aethon",
                    isMain: true,
                  },
                ],
              },
            ],
          },
        }}
        onEvent={onEvent}
      />,
    );

    expect(await screen.findByText("Fix mobile issue rendering")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Send issue #33 to agent" }),
    );

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          projectId: "p1",
          source: "github-issue",
          issueNumber: 33,
          issueUrl: "https://github.com/example/aethon/issues/33",
          issueTitle: "Fix mobile issue rendering",
          newWorkspace: true,
        }),
        "issue-33",
      ),
    );
  });
});
