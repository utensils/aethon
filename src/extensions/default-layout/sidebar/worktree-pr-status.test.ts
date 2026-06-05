import { describe, expect, it } from "vitest";
import type { GhBranchStatus } from "../../../ghBranchStatusCache";
import type { GhChecks } from "../../../ghChecksCache";
import { summarizeWorktreePrStatus } from "./worktree-pr-status";

function status(overrides: Partial<GhBranchStatus> = {}): GhBranchStatus {
  return {
    ghAvailable: true,
    repo: "owner/repo",
    pushed: true,
    worktreeBroken: false,
    prs: [
      {
        number: 12,
        state: "OPEN",
        title: "Feature work",
        url: "https://github.test/pr/12",
        isDraft: false,
        merged: false,
        baseRefName: "main",
      },
    ],
    ...overrides,
  };
}

function checks(overrides: Partial<GhChecks> = {}): GhChecks {
  return {
    ghAvailable: true,
    repo: "owner/repo",
    conclusion: "success",
    total: 1,
    passed: 1,
    failed: 0,
    pending: 0,
    skipped: 0,
    checks: [],
    ...overrides,
  };
}

describe("summarizeWorktreePrStatus", () => {
  it("returns null when there is no applicable GitHub PR", () => {
    expect(summarizeWorktreePrStatus(status({ prs: [] }))).toBeNull();
    expect(
      summarizeWorktreePrStatus(status({ ghAvailable: false, repo: null })),
    ).toBeNull();
  });

  it("summarizes open and draft PRs", () => {
    expect(summarizeWorktreePrStatus(status(), checks())?.label).toBe("#12");
    expect(
      summarizeWorktreePrStatus(
        status({
          prs: [
            {
              number: 13,
              state: "OPEN",
              title: "Draft work",
              url: "u",
              isDraft: true,
              merged: false,
              baseRefName: "main",
            },
          ],
        }),
      )?.label,
    ).toBe("draft #13");
  });

  it("summarizes merged and closed PRs", () => {
    expect(
      summarizeWorktreePrStatus(
        status({
          prs: [
            {
              number: 14,
              state: "CLOSED",
              title: "Merged work",
              url: "u",
              isDraft: false,
              merged: true,
              baseRefName: "main",
            },
          ],
        }),
      )?.label,
    ).toBe("merged #14");
    expect(
      summarizeWorktreePrStatus(
        status({
          prs: [
            {
              number: 15,
              state: "CLOSED",
              title: "Closed work",
              url: "u",
              isDraft: false,
              merged: false,
              baseRefName: "main",
            },
          ],
        }),
      )?.label,
    ).toBe("closed #15");
  });

  it("carries CI rollup into the chip", () => {
    expect(
      summarizeWorktreePrStatus(status(), checks({ conclusion: "failure" }))
        ?.ci,
    ).toBe("failure");
  });

  it("marks broken worktrees as stale", () => {
    expect(
      summarizeWorktreePrStatus(
        status({ worktreeBroken: true, ghAvailable: false, repo: null, prs: [] }),
      )?.label,
    ).toBe("stale");
  });
});
