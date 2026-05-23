// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorktreeRow, type WorktreeSidebarItem } from "./worktree-row";

afterEach(() => cleanup());

function wt(overrides: Partial<WorktreeSidebarItem> = {}): WorktreeSidebarItem {
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

function harness(item: WorktreeSidebarItem) {
  const onEvent = vi.fn();
  const onItemContextMenu = vi.fn();
  render(
    <ul>
      <WorktreeRow
        item={item}
        sectionId="projects"
        onEvent={onEvent}
        onItemContextMenu={onItemContextMenu}
      />
    </ul>,
  );
  return { onEvent, onItemContextMenu };
}

describe("WorktreeRow", () => {
  it("emits switch-worktree on row click", () => {
    const { onEvent } = harness(wt());
    fireEvent.click(screen.getByText("feature-x").closest("li")!);
    expect(onEvent).toHaveBeenCalledWith(
      "switch-worktree",
      expect.objectContaining({ worktreeId: "wt-1", sectionId: "projects" }),
      "wt-1",
    );
  });

  it("emits open-worktree-in-new-tab on double-click", () => {
    const { onEvent } = harness(wt());
    fireEvent.doubleClick(screen.getByText("feature-x").closest("li")!);
    expect(onEvent).toHaveBeenCalledWith(
      "open-worktree-in-new-tab",
      expect.objectContaining({ worktreeId: "wt-1" }),
      "wt-1",
    );
  });

  it("renders pending status with cancel button when queued/starting", () => {
    const { onEvent } = harness(
      wt({ pendingState: "starting", label: "wip" }),
    );
    expect(screen.getByText(/creating/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onEvent).toHaveBeenCalledWith(
      "cancel-pending-worktree",
      expect.objectContaining({ worktreeId: "wt-1" }),
      "wt-1",
    );
    // Row click while pending is a no-op.
    onEvent.mockClear();
    fireEvent.click(screen.getByText("wip").closest("li")!);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("renders retry + dismiss for failed pending entries", () => {
    const { onEvent } = harness(
      wt({ pendingState: "failed", pendingError: "boom", label: "wip" }),
    );
    expect(screen.getByText("failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(onEvent).toHaveBeenCalledWith(
      "retry-pending-worktree",
      expect.objectContaining({ worktreeId: "wt-1" }),
      "wt-1",
    );
  });

  it("flags main worktree with accent glyph", () => {
    harness(wt({ isMain: true, label: "main" }));
    const row = screen.getByText("main").closest("li")!;
    expect(row.className).toContain("ae-worktree-row--main");
  });

  it("invokes onItemContextMenu on right-click", () => {
    const { onItemContextMenu } = harness(wt());
    fireEvent.contextMenu(screen.getByText("feature-x").closest("li")!);
    expect(onItemContextMenu).toHaveBeenCalled();
  });
});
