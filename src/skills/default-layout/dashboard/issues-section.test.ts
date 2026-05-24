import { describe, expect, it } from "vitest";
import { buildIssueBranch, buildIssuePrompt } from "./issue-task";

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
