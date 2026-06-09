// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLanding } from "./layout";
import type { A2UIComponent } from "../../types/a2ui";
import type { GhBranchStatus } from "../../ghBranchStatusCache";

const ghMock = vi.fn(() => Promise.resolve(null as GhBranchStatus | null));
vi.mock("../../ghBranchStatusCache", () => ({
  getGhBranchStatus: (...args: unknown[]) => ghMock(...(args as [])),
}));

afterEach(() => cleanup());

function workspaceLanding(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "workspace-landing",
    type: "workspace-landing",
    props,
  };
}

describe("WorkspaceLanding sessions", () => {
  it("uses the parent project's discovered icon when one is available", () => {
    const { container } = render(
      <WorkspaceLanding
        component={workspaceLanding({
          landing: { $ref: "/landing" },
          recentSessions: { $ref: "/recentSessions" },
        })}
        state={{
          landing: {
            kind: "workspace",
            projectId: "p1",
            projectLabel: "Claudette",
            iconUrl: "asset://localhost/project-icons/claudette.png",
            workspaceId: "wt-1",
            workspaceLabel: "feat/phaethon",
            branch: "feat/phaethon",
            path: "/repo/claudette-feat-phaethon",
          },
          recentSessions: [],
        }}
        onEvent={vi.fn()}
      />,
    );

    const hero = container.querySelector(".a2ui-empty-state-hero")!;
    const image = hero.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "asset://localhost/project-icons/claudette.png",
    );
    expect(hero.querySelector("svg")).toBeNull();
  });

  it("derives the project icon from live sidebar state", () => {
    const { container, rerender } = render(
      <WorkspaceLanding
        component={workspaceLanding({
          landing: { $ref: "/landing" },
          recentSessions: { $ref: "/recentSessions" },
        })}
        state={{
          landing: {
            kind: "workspace",
            projectId: "p1",
            projectLabel: "Claudette",
            workspaceId: "wt-1",
            workspaceLabel: "feat/phaethon",
            branch: "feat/phaethon",
            path: "/repo/claudette-feat-phaethon",
          },
          sidebar: { projects: [{ id: "p1" }] },
          recentSessions: [],
        }}
        onEvent={vi.fn()}
      />,
    );

    expect(container.querySelector(".a2ui-empty-state-hero img")).toBeNull();

    rerender(
      <WorkspaceLanding
        component={workspaceLanding({
          landing: { $ref: "/landing" },
          recentSessions: { $ref: "/recentSessions" },
        })}
        state={{
          landing: {
            kind: "workspace",
            projectId: "p1",
            projectLabel: "Claudette",
            workspaceId: "wt-1",
            workspaceLabel: "feat/phaethon",
            branch: "feat/phaethon",
            path: "/repo/claudette-feat-phaethon",
          },
          sidebar: {
            projects: [
              {
                id: "p1",
                iconUrl: "asset://localhost/project-icons/claudette.png",
              },
            ],
          },
          recentSessions: [],
        }}
        onEvent={vi.fn()}
      />,
    );

    expect(
      container
        .querySelector(".a2ui-empty-state-hero img")
        ?.getAttribute("src"),
    ).toBe("asset://localhost/project-icons/claudette.png");
  });

  it("lists resumable sessions for the selected workspace", () => {
    const onEvent = vi.fn();
    render(
      <WorkspaceLanding
        component={workspaceLanding({
          landing: { $ref: "/landing" },
          recentSessions: { $ref: "/recentSessions" },
        })}
        state={{
          landing: {
            kind: "workspace",
            projectId: "p1",
            projectLabel: "aethon",
            workspaceId: "wt-1",
            workspaceLabel: "fix/session-restore",
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

describe("WorkspaceLanding gh branch status", () => {
  it("renders a broken-workspace notice when workspaceBroken is true", async () => {
    ghMock.mockResolvedValueOnce({
      ghAvailable: false,
      repo: null,
      pushed: false,
      prs: [],
      workspaceBroken: true,
    });
    render(
      <WorkspaceLanding
        component={workspaceLanding({
          landing: { $ref: "/landing" },
          recentSessions: { $ref: "/recentSessions" },
        })}
        state={{
          landing: {
            kind: "workspace",
            projectId: "p1",
            projectLabel: "aethon",
            workspaceId: "wt-broken",
            workspaceLabel: "fix/orphan",
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

  it("does not render the gh status block when workspaceBroken is false and gh is unavailable", async () => {
    ghMock.mockResolvedValueOnce({
      ghAvailable: false,
      repo: null,
      pushed: false,
      prs: [],
      workspaceBroken: false,
    });
    render(
      <WorkspaceLanding
        component={workspaceLanding({
          landing: { $ref: "/landing" },
          recentSessions: { $ref: "/recentSessions" },
        })}
        state={{
          landing: {
            kind: "workspace",
            projectId: "p1",
            projectLabel: "aethon",
            workspaceId: "wt-healthy",
            workspaceLabel: "main",
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
