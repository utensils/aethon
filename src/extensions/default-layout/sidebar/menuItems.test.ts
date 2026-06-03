import { describe, expect, it } from "vitest";
import { canRemoveWorktree, canRenameWorktree } from "./menuItems";
import type { WorktreeSidebarItem } from "./worktree-row";

function wt(
  overrides: Partial<WorktreeSidebarItem> = {},
): WorktreeSidebarItem {
  return {
    id: "wt-1",
    label: "feature-x",
    branch: "feature-x",
    path: "/repo-feature-x",
    active: false,
    isMain: false,
    ...overrides,
  };
}

describe("canRenameWorktree", () => {
  it("requires a worktree item", () => {
    expect(canRenameWorktree(undefined)).toBe(false);
  });

  it("allows non-pending worktrees", () => {
    expect(canRenameWorktree(wt())).toBe(true);
    expect(canRenameWorktree(wt({ pendingState: "succeeded" }))).toBe(true);
  });

  it("rejects pending or failed worktrees", () => {
    expect(canRenameWorktree(wt({ pendingState: "queued" }))).toBe(false);
    expect(canRenameWorktree(wt({ pendingState: "starting" }))).toBe(false);
    expect(canRenameWorktree(wt({ pendingState: "removing" }))).toBe(false);
    expect(canRenameWorktree(wt({ pendingState: "failed" }))).toBe(false);
  });
});

describe("canRemoveWorktree", () => {
  it("rejects missing, main, and pending worktrees", () => {
    expect(canRemoveWorktree(undefined)).toBe(false);
    expect(canRemoveWorktree(wt({ isMain: true }))).toBe(false);
    expect(canRemoveWorktree(wt({ pendingState: "queued" }))).toBe(false);
    expect(canRemoveWorktree(wt({ pendingState: "starting" }))).toBe(false);
    expect(canRemoveWorktree(wt({ pendingState: "removing" }))).toBe(false);
    expect(canRemoveWorktree(wt({ pendingState: "failed" }))).toBe(false);
  });

  it("allows removable live worktrees", () => {
    expect(canRemoveWorktree(wt())).toBe(true);
    expect(canRemoveWorktree(wt({ pendingState: "succeeded" }))).toBe(true);
  });
});
