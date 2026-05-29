/**
 * Pure mapping tests for the shared VCS presentation helpers. These keep
 * the header cluster and the source-control panel in agreement on what a
 * given CI/PR state looks like, so they're worth pinning precisely.
 */
import { describe, expect, it } from "vitest";

import type { VcsCi, VcsChanges, VcsPr } from "../../../hooks/useVcsStatus";
import { changeBreakdown, ciMeta, prMeta } from "./vcs-presentation";

function ci(over: Partial<VcsCi> = {}): VcsCi {
  return {
    conclusion: "success",
    total: 4,
    passed: 4,
    failed: 0,
    pending: 0,
    skipped: 0,
    checks: [],
    ...over,
  };
}

function pr(over: Partial<VcsPr> = {}): VcsPr {
  return {
    number: 7,
    state: "OPEN",
    title: "Add widget",
    url: "https://gh/pr/7",
    isDraft: false,
    merged: false,
    baseRefName: "main",
    ...over,
  };
}

function changes(over: Partial<VcsChanges> = {}): VcsChanges {
  return {
    total: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    renamed: 0,
    copied: 0,
    conflicted: 0,
    files: [],
    ...over,
  };
}

describe("ciMeta", () => {
  it("returns null for no CI / no conclusion", () => {
    expect(ciMeta(null)).toBeNull();
    expect(ciMeta(ci({ conclusion: null }))).toBeNull();
    // "none" (repo has no checks) is not a renderable conclusion.
    expect(ciMeta(ci({ conclusion: "none" }))).toBeNull();
  });

  it("maps success to a passing tone", () => {
    const m = ciMeta(ci())!;
    expect(m.tone).toBe("success");
    expect(m.icon).toBe("✓");
    expect(m.title).toBe("4/4 checks passed");
  });

  it("pluralises the failing label", () => {
    expect(ciMeta(ci({ conclusion: "failure", failed: 1, total: 4 }))!.label).toBe(
      "check failing",
    );
    expect(ciMeta(ci({ conclusion: "failure", failed: 3, total: 4 }))!.label).toBe(
      "3 failing",
    );
  });

  it("maps pending and neutral", () => {
    expect(ciMeta(ci({ conclusion: "pending", pending: 2 }))!.tone).toBe("pending");
    expect(ciMeta(ci({ conclusion: "neutral" }))!.tone).toBe("neutral");
  });
});

describe("prMeta", () => {
  it("returns null without a PR", () => {
    expect(prMeta(null)).toBeNull();
  });

  it("prefers merged state over everything", () => {
    expect(prMeta(pr({ merged: true }))!.label).toBe("merged");
    expect(prMeta(pr({ state: "MERGED" }))!.label).toBe("merged");
  });

  it("maps closed, draft, and open", () => {
    expect(prMeta(pr({ state: "CLOSED" }))!).toMatchObject({
      label: "closed",
      tone: "failure",
    });
    expect(prMeta(pr({ isDraft: true }))!).toMatchObject({
      label: "draft",
      tone: "muted",
    });
    expect(prMeta(pr())!).toMatchObject({ label: "open", tone: "success" });
  });
});

describe("changeBreakdown", () => {
  it("omits zero buckets and orders M A D R C U !", () => {
    expect(
      changeBreakdown(
        changes({
          modified: 12,
          added: 3,
          deleted: 1,
          untracked: 2,
          conflicted: 1,
        }),
      ),
    ).toBe("12M 3A 1D 2U 1!");
  });

  it("is empty when there are no changes", () => {
    expect(changeBreakdown(changes())).toBe("");
  });
});
