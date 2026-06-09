import { describe, expect, it } from "vitest";
import type { GhBranchStatus } from "../../../ghBranchStatusCache";
import type { GhChecks } from "../../../ghChecksCache";
import { summarizeWorkspacePrStatus } from "./workspace-pr-status";

function status(overrides: Partial<GhBranchStatus> = {}): GhBranchStatus {
  return {
    ghAvailable: true,
    repo: "owner/repo",
    pushed: true,
    workspaceBroken: false,
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

describe("summarizeWorkspacePrStatus", () => {
  it("returns null when there is no applicable GitHub PR", () => {
    expect(summarizeWorkspacePrStatus(status({ prs: [] }))).toBeNull();
    expect(
      summarizeWorkspacePrStatus(status({ ghAvailable: false, repo: null })),
    ).toBeNull();
  });

  it("summarizes open and draft PRs", () => {
    const openChip = summarizeWorkspacePrStatus(status(), checks());
    expect(openChip?.label).toBe("open #12");
    expect(openChip?.kind).toBe("open");
    expect(openChip?.title).toContain("CI success");
    expect(
      summarizeWorkspacePrStatus(
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
    expect(
      summarizeWorkspacePrStatus(
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
      )?.kind,
    ).toBe("draft");
  });

  it("summarizes merged and closed PRs", () => {
    expect(
      summarizeWorkspacePrStatus(
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
      summarizeWorkspacePrStatus(
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
    const chip = summarizeWorkspacePrStatus(
      status(),
      checks({ conclusion: "failure" }),
    );
    expect(chip?.ci).toBe("failure");
    expect(chip?.title).toContain("CI failure");
    expect(
      summarizeWorkspacePrStatus(status(), checks({ conclusion: "pending" }))
        ?.ci,
    ).toBe("pending");
    expect(
      summarizeWorkspacePrStatus(status(), checks({ conclusion: "neutral" }))
        ?.ci,
    ).toBe("neutral");
  });

  it("marks broken workspaces as stale", () => {
    expect(
      summarizeWorkspacePrStatus(
        status({ workspaceBroken: true, ghAvailable: false, repo: null, prs: [] }),
      )?.label,
    ).toBe("stale");
  });
});
