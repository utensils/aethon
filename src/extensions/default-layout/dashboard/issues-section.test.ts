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
import {
  buildIssueBranch,
  buildIssuePrompt,
  buildIssueTask,
  interpolateIssueTemplate,
} from "./issue-task";
import {
  loadIssueTemplates,
  matchingIssueTemplates,
  type IssueTemplate,
} from "./issue-templates";
import type { GhIssue } from "../../../ghIssuesCache";

const { getIssueDetail, refreshIssues, openUrl, invoke } = vi.hoisted(() => ({
  getIssueDetail: vi.fn(),
  refreshIssues: vi.fn(),
  openUrl: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("../../../ghIssuesCache", () => ({
  getIssueDetail: (...args: unknown[]) => getIssueDetail(...args),
  refreshIssues: (...args: unknown[]) => refreshIssues(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
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

function renderIssues(
  onEvent = vi.fn(),
  templateConfig: unknown = { templates: [], warning: null },
) {
  refreshIssues.mockResolvedValue([issue]);
  getIssueDetail.mockResolvedValue({
    ...issue,
    body: "Rename should stay available.",
  });
  invoke.mockResolvedValue(templateConfig);
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
        activeWorkspaceId: "wt-current",
        sidebar: {
          projects: [
            {
              id: "p1",
              workspaces: [
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

  it("caps generated issue branch length at a sidebar-friendly size", () => {
    const branch = buildIssueBranch({
      number: 85,
      title: "Cannot rename session tab while agent is running",
      labels: [{ name: "bug", color: null }],
    });

    expect(branch).toBe("fix/issue-85-cannot-rename-session-tab-while");
    expect(branch.length).toBeLessThanOrEqual(44);
  });

  it("keeps collision suffixes within the branch length cap", () => {
    const base = "fix/issue-85-cannot-rename-session-tab-while";
    const branch = buildIssueBranch(
      {
        number: 85,
        title: "Cannot rename session tab while agent is running",
        labels: [{ name: "bug", color: null }],
      },
      new Set([base]),
    );

    expect(branch).toBe("fix/issue-85-cannot-rename-session-tab-2");
    expect(branch.length).toBeLessThanOrEqual(44);
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
    ).toBe("feat/issue-213-admin-add-recreate-missing");
  });

  it("falls back to labels when the title has no conventional type", () => {
    expect(
      buildIssueBranch({
        number: 99,
        title: "ACRIS deed not showing on BBL view",
        labels: [{ name: "bug", color: null }],
      }),
    ).toBe("fix/issue-99-acris-deed-not-showing-on-bbl");

    expect(
      buildIssueBranch({
        number: 180,
        title: "Add dealflow pipeline management tools",
        labels: [{ name: "enhancement", color: null }],
      }),
    ).toBe("feat/issue-180-add-dealflow-pipeline");
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

  it("interpolates configured issue templates with issue and project variables", () => {
    const template: IssueTemplate = {
      id: "docs",
      label: "Docs issue",
      prompt:
        "Work on #{number}: {title}\nLabels: {labels}\nSlug: {slug}\nProject: {projectLabel}",
      newWorkspace: true,
      branch: "{branchPrefix}/issue-{number}-{slug}",
      branchPrefix: "docs",
      whenLabels: ["documentation"],
    };

    const task = buildIssueTask(
      {
        number: 213,
        title: "docs(api): Explain templates",
        url: "https://github.com/utensils/aethon/issues/213",
        body: "Add docs.",
        author: "octo",
      },
      {
        ...issue,
        number: 213,
        title: "docs(api): Explain templates",
        labels: [{ name: "documentation", color: null }],
        comments: 2,
      },
      { id: "p1", label: "aethon", path: "/repo/aethon" },
      { template },
    );

    expect(task.prompt).toContain("Work on #213: docs(api): Explain templates");
    expect(task.prompt).toContain("Labels: documentation");
    expect(task.prompt).toContain("Slug: api-explain-templates");
    expect(task.prompt).toContain("Project: aethon");
    expect(task.branch).toBe("docs/issue-213-api-explain-templates");
  });

  it("falls back to the derived prefix when a branchPrefix override is empty", () => {
    const template: IssueTemplate = {
      id: "empty-prefix",
      label: "Empty prefix",
      prompt: "Work on #{number}",
      newWorkspace: true,
      // Interpolates to an empty string for an issue with no labels — must
      // not collapse `{branchPrefix}` into a leading slash (`/issue-...`).
      branch: "{branchPrefix}/issue-{number}-{slug}",
      branchPrefix: "{labels}",
      whenLabels: [],
    };

    const task = buildIssueTask(
      {
        number: 99,
        title: "Investigate flaky import",
        url: "https://github.com/utensils/aethon/issues/99",
        body: "",
        author: "octo",
      },
      { ...issue, number: 99, title: "Investigate flaky import", labels: [] },
      { id: "p1", label: "aethon", path: "/repo/aethon" },
      { template },
    );

    expect(task.branch).toBe("fix/issue-99-investigate-flaky-import");
    expect(task.branch?.startsWith("/")).toBe(false);
  });

  it("matches label-specific templates before catch-all templates", () => {
    const templates: IssueTemplate[] = [
      {
        id: "default",
        label: "Default",
        prompt: "Default {title}",
        newWorkspace: null,
        branch: null,
        branchPrefix: null,
        whenLabels: [],
      },
      {
        id: "docs",
        label: "Docs",
        prompt: "Docs {title}",
        newWorkspace: null,
        branch: null,
        branchPrefix: null,
        whenLabels: ["Documentation"],
      },
    ];

    expect(
      matchingIssueTemplates(templates, {
        ...issue,
        labels: [{ name: "documentation", color: null }],
      }).map((t) => t.id),
    ).toEqual(["docs", "default"]);
  });

  it("loads issue templates from the project config command", async () => {
    invoke.mockResolvedValueOnce({
      templates: [
        {
          id: "default",
          label: "Default",
          prompt: "Work on {title}",
          newWorkspace: true,
          branch: null,
          branchPrefix: null,
          whenLabels: [],
        },
      ],
      warning: null,
    });

    await expect(loadIssueTemplates("/repo/aethon")).resolves.toMatchObject({
      templates: [expect.objectContaining({ id: "default" })],
      warning: null,
    });
    expect(invoke).toHaveBeenCalledWith("read_issue_templates", {
      projectPath: "/repo/aethon",
    });
  });

  it("falls back when issue template loading fails", async () => {
    invoke.mockRejectedValueOnce(new Error("bad toml"));

    await expect(loadIssueTemplates("/repo/aethon")).resolves.toMatchObject({
      templates: [],
      warning: expect.stringContaining("using built-in issue prompt"),
    });
  });

  it("replaces unknown template variables with an empty string", () => {
    expect(interpolateIssueTemplate("Known {title} missing {nope}", {
      title: "Crash",
    })).toBe("Known Crash missing ");
  });
});

describe("IssuesSection", () => {
  it("force-refreshes issues on first visible load", async () => {
    renderIssues();

    await screen.findByText(issue.title);
    expect(refreshIssues).toHaveBeenCalledWith("/repo/aethon", 30);
  });

  it("sends the hover action to a fresh workspace by default", async () => {
    const { onEvent } = renderIssues();

    await screen.findByText(issue.title);
    fireEvent.click(screen.getByRole("button", { name: /send issue #85/i }));

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          projectId: "p1",
          newWorkspace: true,
          branch: expect.stringMatching(/^fix\/issue-85-/),
          source: "github-issue",
          issueNumber: 85,
        }),
        "issue-85",
      ),
    );
  });

  it("uses a configured template for issue launches", async () => {
    const { onEvent } = renderIssues(vi.fn(), {
      templates: [
        {
          id: "default",
          label: "Default implementation task",
          prompt: "CUSTOM #{number}: {title}\n{body}",
          newWorkspace: true,
          branch: "feat/issue-{number}-{slug}",
          branchPrefix: null,
          whenLabels: [],
        },
      ],
      warning: null,
    });

    await screen.findByText(issue.title);
    fireEvent.click(screen.getByRole("button", { name: /send issue #85/i }));

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          prompt: expect.stringContaining("CUSTOM #85"),
          // Template-generated branches are compacted to the same ceiling as
          // the built-in path so long slugs can't blow past OS path limits.
          branch: "feat/issue-85-cannot-rename-session-tab",
          issueTemplateId: "default",
        }),
        "issue-85",
      ),
    );
  });

  it("offers both new-workspace and current-workspace launches in the context menu", async () => {
    renderIssues();

    await screen.findByText(issue.title);
    fireEvent.contextMenu(screen.getByText(issue.title).closest("li")!);

    expect(
      screen.getByRole("menuitem", { name: "Send to agent (new workspace)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", {
        name: "Send to agent (current workspace/branch)",
      }),
    ).toBeTruthy();
  });

  it("sends context-menu current workspace launches to the active workspace", async () => {
    const { onEvent } = renderIssues();

    await screen.findByText(issue.title);
    fireEvent.contextMenu(screen.getByText(issue.title).closest("li")!);
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Send to agent (current workspace/branch)",
      }),
    );

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          projectId: "p1",
          newWorkspace: false,
          workspaceId: "wt-current",
          source: "github-issue",
          issueNumber: 85,
        }),
        "issue-85",
      ),
    );
  });

  it("lets the context menu choose between multiple matching templates", async () => {
    const { onEvent } = renderIssues(vi.fn(), {
      templates: [
        {
          id: "default",
          label: "Default",
          prompt: "DEFAULT {title}",
          newWorkspace: true,
          branch: null,
          branchPrefix: null,
          whenLabels: [],
        },
        {
          id: "bug",
          label: "Bug fix handoff",
          prompt: "BUGFIX {title}",
          newWorkspace: false,
          branch: null,
          branchPrefix: null,
          whenLabels: ["bug"],
        },
      ],
      warning: null,
    });

    await screen.findByText(issue.title);
    fireEvent.contextMenu(screen.getByText(issue.title).closest("li")!);

    expect(
      screen.getByRole("menuitem", { name: "Use template: Bug fix handoff" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Use template: Bug fix handoff" }),
    );

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          prompt: expect.stringContaining("BUGFIX"),
          newWorkspace: false,
          workspaceId: "wt-current",
          issueTemplateId: "bug",
        }),
        "issue-85",
      ),
    );
  });

  it("surfaces malformed template warnings without blocking fallback", async () => {
    renderIssues(vi.fn(), {
      templates: [],
      warning: "Malformed .aethon/issues.toml; using built-in issue prompt.",
    });

    await screen.findByText(issue.title);
    expect(screen.getByText(/Malformed \.aethon\/issues\.toml/)).toBeTruthy();
  });
});
