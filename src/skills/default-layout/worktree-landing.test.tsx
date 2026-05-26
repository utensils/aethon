// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeLanding } from "./layout";
import type { A2UIComponent } from "../../types/a2ui";
import type { GhBranchStatus } from "../../ghBranchStatusCache";

const ghMock = vi.fn(() => Promise.resolve(null as GhBranchStatus | null));
vi.mock("../../ghBranchStatusCache", () => ({
  getGhBranchStatus: (...args: unknown[]) => ghMock(...(args as [])),
}));

afterEach(() => cleanup());

function worktreeLanding(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "worktree-landing",
    type: "worktree-landing",
    props,
  };
}

describe("WorktreeLanding sessions", () => {
  it("lists resumable sessions for the selected worktree", () => {
    const onEvent = vi.fn();
    render(
      <WorktreeLanding
        component={worktreeLanding({
          landing: { $ref: "/landing" },
          recentSessions: { $ref: "/recentSessions" },
        })}
        state={{
          landing: {
            kind: "worktree",
            projectId: "p1",
            projectLabel: "aethon",
            worktreeId: "wt-1",
            worktreeLabel: "fix/session-restore",
            branch: "fix/session-restore",
            path: "/repo/aethon-fix",
          },
          recentSessions: [
            {
              id: "session-wt",
              label: "Continue the fix",
              lastModified: "5m ago",
              cwd: "/repo/aethon-fix/",
            },
            {
              id: "session-main",
              label: "Main branch work",
              lastModified: "1h ago",
              cwd: "/repo/aethon",
            },
          ],
        }}
        onEvent={onEvent}
      />,
    );

    expect(screen.getByText("Recent sessions")).toBeTruthy();
    expect(screen.getByText("Continue the fix")).toBeTruthy();
    expect(screen.queryByText("Main branch work")).toBeNull();

    fireEvent.click(screen.getByText("Continue the fix"));
    expect(onEvent).toHaveBeenCalledWith(
      "restore-session",
      {
        sessionId: "session-wt",
        label: "Continue the fix",
        cwd: "/repo/aethon-fix/",
      },
      "session-wt",
    );
  });
});

describe("WorktreeLanding gh branch status", () => {
  it("renders a broken-worktree notice when worktreeBroken is true", async () => {
    ghMock.mockResolvedValueOnce({
      ghAvailable: false,
      repo: null,
      pushed: false,
      prs: [],
      worktreeBroken: true,
    });
    render(
      <WorktreeLanding
        component={worktreeLanding({
          landing: { $ref: "/landing" },
          recentSessions: { $ref: "/recentSessions" },
        })}
        state={{
          landing: {
            kind: "worktree",
            projectId: "p1",
            projectLabel: "aethon",
            worktreeId: "wt-broken",
            worktreeLabel: "fix/orphan",
            branch: "fix/orphan",
            path: "/repo/aethon-broken",
          },
          recentSessions: [],
        }}
        onEvent={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/no longer tracked by git/i)).toBeTruthy(),
    );
  });

  it("does not render the gh status block when worktreeBroken is false and gh is unavailable", async () => {
    ghMock.mockResolvedValueOnce({
      ghAvailable: false,
      repo: null,
      pushed: false,
      prs: [],
      worktreeBroken: false,
    });
    render(
      <WorktreeLanding
        component={worktreeLanding({
          landing: { $ref: "/landing" },
          recentSessions: { $ref: "/recentSessions" },
        })}
        state={{
          landing: {
            kind: "worktree",
            projectId: "p1",
            projectLabel: "aethon",
            worktreeId: "wt-healthy",
            worktreeLabel: "main",
            branch: "main",
            path: "/repo/aethon",
          },
          recentSessions: [],
        }}
        onEvent={vi.fn()}
      />,
    );
    // Wait one tick so the effect runs.
    await waitFor(() => expect(ghMock).toHaveBeenCalled());
    expect(screen.queryByText(/no longer tracked|branch status/i)).toBeNull();
  });
});
