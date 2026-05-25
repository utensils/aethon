// @vitest-environment jsdom
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssuesSection } from "./issues-section";
import { buildIssueBranch, buildIssuePrompt } from "./issue-task";
import type { GhIssue } from "../../../ghIssuesCache";

const { getIssues, getIssueDetail, openUrl } = vi.hoisted(() => ({
  getIssues: vi.fn(),
  getIssueDetail: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("../../../ghIssuesCache", () => ({
  getIssues: (...args: unknown[]) => getIssues(...args),
  getIssueDetail: (...args: unknown[]) => getIssueDetail(...args),
  refreshIssues: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const issue: GhIssue = {
  number: 85,
  title: "Cannot rename session tab while agent is running",
  url: "https://github.com/utensils/aethon/issues/85",
  state: "open",
  author: "jamesbrink",
  updatedAt: "2026-05-25T15:00:00Z",
  labels: [{ name: "bug", color: "d73a4a" }],
  comments: 0,
};

function renderIssues(onEvent = vi.fn()) {
  getIssues.mockResolvedValue([issue]);
  getIssueDetail.mockResolvedValue({
    ...issue,
    body: "Rename should stay available.",
  });
  render(
    createElement(IssuesSection, {
      component: {
        id: "issues",
        type: "issues-section",
        props: {
          project: { id: "p1", label: "aethon", path: "/repo/aethon" },
        },
      },
      state: {
        activeWorktreeId: "wt-current",
        sidebar: {
          projects: [
            {
              id: "p1",
              worktrees: [
                { id: "wt-current", branch: "fix/current", active: true },
                { id: "wt-other", branch: "fix/issue-85-existing" },
              ],
            },
          ],
        },
      },
      onEvent,
    }),
  );
  return { onEvent };
}

describe("issues-section task helpers", () => {
  it("builds a descriptive issue branch and avoids loaded collisions", () => {
    const existing = new Set([
      "fix/issue-123-support-origin-main-defaults",
      "fix/issue-123-support-origin-main-defaults-2",
    ]);

    expect(
      buildIssueBranch(
        {
          number: 123,
          title: "Support origin/main defaults!",
          labels: [{ name: "bug", color: null }],
        },
        existing,
      ),
    ).toBe("fix/issue-123-support-origin-main-defaults-3");
  });

  it("uses conventional issue titles for branch type and slug", () => {
    expect(
      buildIssueBranch({
        number: 213,
        title:
          "feat(admin): add Recreate Missing Materialized Views to admin panel",
        labels: [
          { name: "enhancement", color: null },
          { name: "low-priority", color: null },
        ],
      }),
    ).toBe("feat/issue-213-admin-add-recreate-missing-materialized-views-to");
  });

  it("falls back to labels when the title has no conventional type", () => {
    expect(
      buildIssueBranch({
        number: 99,
        title: "ACRIS deed not showing on BBL view",
        labels: [{ name: "bug", color: null }],
      }),
    ).toBe("fix/issue-99-acris-deed-not-showing-on-bbl-view");

    expect(
      buildIssueBranch({
        number: 180,
        title: "Add dealflow pipeline management tools",
        labels: [{ name: "enhancement", color: null }],
      }),
    ).toBe("feat/issue-180-add-dealflow-pipeline-management-tools");
  });

  it("respects non-feature conventional types and labels", () => {
    expect(
      buildIssueBranch({
        number: 12,
        title: "docs(api): explain model config",
        labels: [{ name: "enhancement", color: null }],
      }),
    ).toBe("docs/issue-12-api-explain-model-config");

    expect(
      buildIssueBranch({
        number: 13,
        title: "Bump bundled agent package",
        labels: [{ name: "dependencies", color: null }],
      }),
    ).toBe("chore/issue-13-bump-bundled-agent-package");

    expect(
      buildIssueBranch({
        number: 14,
        title: "Speed up dashboard render",
        labels: [{ name: "performance", color: null }],
      }),
    ).toBe("perf/issue-14-speed-up-dashboard-render");
  });

  it("uses fix as the unknown fallback", () => {
    expect(
      buildIssueBranch({
        number: 55,
        title: "Investigate flaky import",
        labels: [],
      }),
    ).toBe("fix/issue-55-investigate-flaky-import");
  });

  it("keeps issue prompt source details", () => {
    expect(
      buildIssuePrompt({
        number: 7,
        title: "Crash on boot",
        url: "https://github.com/example/repo/issues/7",
        body: "",
        author: "octo",
      }),
    ).toContain("Please work on GitHub issue #7");
  });
});

describe("IssuesSection", () => {
  it("sends the hover action to a fresh worktree by default", async () => {
    const { onEvent } = renderIssues();

    await screen.findByText(issue.title);
    fireEvent.click(screen.getByRole("button", { name: /send issue #85/i }));

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          projectId: "p1",
          newWorktree: true,
          branch: expect.stringMatching(/^fix\/issue-85-/),
          source: "github-issue",
          issueNumber: 85,
        }),
        "issue-85",
      ),
    );
  });

  it("offers both new-worktree and current-worktree launches in the context menu", async () => {
    renderIssues();

    await screen.findByText(issue.title);
    fireEvent.contextMenu(screen.getByText(issue.title).closest("li")!);

    expect(
      screen.getByRole("menuitem", { name: "Send to agent (new worktree)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", {
        name: "Send to agent (current worktree/branch)",
      }),
    ).toBeTruthy();
  });

  it("sends context-menu current worktree launches to the active worktree", async () => {
    const { onEvent } = renderIssues();

    await screen.findByText(issue.title);
    fireEvent.contextMenu(screen.getByText(issue.title).closest("li")!);
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Send to agent (current worktree/branch)",
      }),
    );

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          projectId: "p1",
          newWorktree: false,
          worktreeId: "wt-current",
          source: "github-issue",
          issueNumber: 85,
        }),
        "issue-85",
      ),
    );
  });
});
