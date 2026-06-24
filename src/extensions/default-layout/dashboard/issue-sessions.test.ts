import { describe, expect, it } from "vitest";
import { makeEmptyTab } from "../../../types/tab";
import type { TabBucket } from "../../../hooks/projectOps/types";
import {
  clearClosedIssueLinks,
  clearClosedIssueLinksInBuckets,
  firstIssueSessionTab,
} from "./issue-sessions";

const sourceIssue = {
  kind: "github-issue" as const,
  projectId: "p1",
  number: 85,
  url: "https://github.com/utensils/aethon/issues/85",
  title: "Cannot rename session tab while agent is running",
  branch: "fix/issue-85-existing",
  workspaceId: "wt-85",
  workspacePath: "/repo/aethon-issue-85",
  createdAt: 1,
};

describe("issue session links", () => {
  it("finds issue sessions across active tabs and persisted buckets", () => {
    const hidden = {
      ...makeEmptyTab("hidden", "Hidden", "p1"),
      sourceIssue,
    };
    const state = {
      tabs: [makeEmptyTab("active", "Active", "p1")],
      persistedTabBuckets: {
        "p1::workspace::wt-85": { tabs: [hidden], activeTabId: "hidden" },
      },
    };

    expect(firstIssueSessionTab(state, "p1", 85)?.id).toBe("hidden");
  });

  it("clears closed issue links from state and live buckets", () => {
    const active = {
      ...makeEmptyTab("active", "Active", "p1"),
      sourceIssue,
    };
    const hidden = {
      ...makeEmptyTab("hidden", "Hidden", "p1"),
      sourceIssue,
    };
    const state = clearClosedIssueLinks(
      {
        tabs: [active],
        persistedTabBuckets: {
          "p1::workspace::wt-85": { tabs: [hidden], activeTabId: "hidden" },
        },
      },
      "p1",
      new Set([84]),
    );
    const buckets = new Map<string, TabBucket>([
      ["p1::workspace::wt-85", { tabs: [hidden], activeTabId: "hidden" }],
    ]);

    expect((state.tabs as Array<typeof active>)[0].sourceIssue).toBeUndefined();
    expect(
      (state.persistedTabBuckets as Record<string, TabBucket>)[
        "p1::workspace::wt-85"
      ].tabs[0].sourceIssue,
    ).toBeUndefined();
    expect(clearClosedIssueLinksInBuckets(buckets, "p1", new Set([84]))).toBe(
      true,
    );
    expect(
      buckets.get("p1::workspace::wt-85")?.tabs[0].sourceIssue,
    ).toBeUndefined();
  });
});
