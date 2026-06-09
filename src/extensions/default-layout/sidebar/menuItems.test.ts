import { describe, expect, it } from "vitest";
import { canRemoveWorkspace, canRenameWorkspace } from "./menuItems";
import type { WorkspaceSidebarItem } from "./workspace-row";

function wt(
  overrides: Partial<WorkspaceSidebarItem> = {},
): WorkspaceSidebarItem {
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

describe("canRenameWorkspace", () => {
  it("requires a workspace item", () => {
    expect(canRenameWorkspace(undefined)).toBe(false);
  });

  it("allows non-pending workspaces", () => {
    expect(canRenameWorkspace(wt())).toBe(true);
    expect(canRenameWorkspace(wt({ pendingState: "succeeded" }))).toBe(true);
  });

  it("rejects pending or failed workspaces", () => {
    expect(canRenameWorkspace(wt({ pendingState: "queued" }))).toBe(false);
    expect(canRenameWorkspace(wt({ pendingState: "starting" }))).toBe(false);
    expect(canRenameWorkspace(wt({ pendingState: "removing" }))).toBe(false);
    expect(canRenameWorkspace(wt({ pendingState: "failed" }))).toBe(false);
  });
});

describe("canRemoveWorkspace", () => {
  it("rejects missing, main, and pending workspaces", () => {
    expect(canRemoveWorkspace(undefined)).toBe(false);
    expect(canRemoveWorkspace(wt({ isMain: true }))).toBe(false);
    expect(canRemoveWorkspace(wt({ pendingState: "queued" }))).toBe(false);
    expect(canRemoveWorkspace(wt({ pendingState: "starting" }))).toBe(false);
    expect(canRemoveWorkspace(wt({ pendingState: "removing" }))).toBe(false);
    expect(canRemoveWorkspace(wt({ pendingState: "failed" }))).toBe(false);
  });

  it("allows removable live workspaces", () => {
    expect(canRemoveWorkspace(wt())).toBe(true);
    expect(canRemoveWorkspace(wt({ pendingState: "succeeded" }))).toBe(true);
  });
});
