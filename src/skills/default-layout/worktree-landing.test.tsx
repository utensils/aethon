// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeLanding } from "./layout";
import type { A2UIComponent } from "../../types/a2ui";

vi.mock("../../ghBranchStatusCache", () => ({
  getGhBranchStatus: vi.fn(() => Promise.resolve(null)),
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
