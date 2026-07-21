import { describe, expect, it } from "vitest";
import {
  buildSidebarMenuItems,
  canRemoveWorkspace,
  canRenameWorkspace,
  canUnlockWorkspace,
  isRemoteWorkspace,
  type SidebarMenuHandlers,
} from "./menuItems";
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

  it("rejects remote workspaces", () => {
    expect(
      canRenameWorkspace(wt({ hostId: "remote:bender", remoteId: "feature" })),
    ).toBe(false);
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

  it("rejects remote workspaces", () => {
    expect(
      canRemoveWorkspace(wt({ hostId: "remote:bender", remoteId: "feature" })),
    ).toBe(false);
  });
});

describe("isRemoteWorkspace", () => {
  it("detects remote workspace mirrors", () => {
    expect(isRemoteWorkspace(wt({ hostId: "remote:bender" }))).toBe(true);
    expect(isRemoteWorkspace(wt({ remoteId: "feature" }))).toBe(true);
    expect(isRemoteWorkspace(wt({ hostId: "local:bender" }))).toBe(false);
  });
});

describe("canUnlockWorkspace", () => {
  it("allows only live locked local workspaces", () => {
    expect(canUnlockWorkspace(wt({ locked: true }))).toBe(true);
    expect(canUnlockWorkspace(wt())).toBe(false);
    expect(canUnlockWorkspace(wt({ locked: true, pendingState: "removing" }))).toBe(false);
    expect(
      canUnlockWorkspace(
        wt({ locked: true, hostId: "remote:bender", remoteId: "feature" }),
      ),
    ).toBe(false);
  });
});

describe("buildSidebarMenuItems workspace", () => {
  const noop = () => {};
  const handlers = new Proxy(
    {},
    { get: () => noop },
  ) as unknown as SidebarMenuHandlers;

  it("hides local-only workspace verbs for remote rows", () => {
    const items = buildSidebarMenuItems(
      {
        x: 0,
        y: 0,
        sectionId: "projects",
        itemId: "remote:bender::workspace::feature",
        label: "feature",
        kind: "workspace",
        workspace: wt({ hostId: "remote:bender", remoteId: "feature" }),
      },
      handlers,
    );
    const ids = items.flatMap((item) => ("id" in item ? [item.id] : []));

    expect(ids).toEqual(["copy-path"]);
    expect(items).toContainEqual({
      type: "note",
      label: "Remote workspace actions run on that host.",
    });
  });

  it("offers unlock only for a locked local workspace", () => {
    const lockedItems = buildSidebarMenuItems(
      {
        x: 0,
        y: 0,
        sectionId: "projects",
        itemId: "wt-1",
        label: "feature-x",
        kind: "workspace",
        workspace: wt({ locked: true }),
      },
      handlers,
    );
    const unlockedItems = buildSidebarMenuItems(
      {
        x: 0,
        y: 0,
        sectionId: "projects",
        itemId: "wt-1",
        label: "feature-x",
        kind: "workspace",
        workspace: wt(),
      },
      handlers,
    );

    expect(lockedItems).toContainEqual(
      expect.objectContaining({ id: "unlock-workspace", label: "Unlock workspace" }),
    );
    expect(unlockedItems).not.toContainEqual(
      expect.objectContaining({ id: "unlock-workspace" }),
    );
  });
});
