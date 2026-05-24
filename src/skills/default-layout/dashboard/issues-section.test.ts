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
        { number: 123, title: "Support origin/main defaults!" },
        existing,
      ),
    ).toBe("fix/issue-123-support-origin-main-defaults-3");
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
