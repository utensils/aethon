// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";

const { branchStatusMock, checksMock } = vi.hoisted(() => ({
  branchStatusMock: vi.fn(),
  checksMock: vi.fn(),
}));

vi.mock("../../../ghBranchStatusCache", () => ({
  getGhBranchStatus: branchStatusMock,
}));
vi.mock("../../../ghChecksCache", () => ({
  getGhChecks: checksMock,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

import {
  WORKTREE_PENDING_CI_REFRESH_MS,
  WORKTREE_PR_REFRESH_MS,
  WorktreeRow,
  type WorktreeSidebarItem,
} from "./worktree-row";

afterEach(() => {
  vi.useRealTimers();
  branchStatusMock.mockReset();
  checksMock.mockReset();
  vi.mocked(openUrl).mockReset();
  cleanup();
});

function wt(overrides: Partial<WorktreeSidebarItem> = {}): WorktreeSidebarItem {
  return {
    id: "wt-1",
    projectId: "p1",
    label: "feature-x",
    branch: "feature-x",
    path: "/repo-feature-x",
    active: false,
    isMain: false,
    ...overrides,
  };
}

function harness(
  item: WorktreeSidebarItem,
  options: { renaming?: boolean } = {},
) {
  const onEvent = vi.fn();
  const onItemContextMenu = vi.fn();
  const onRenameEnd = vi.fn();
  const view = render(
    <ul>
      <WorktreeRow
        item={item}
        sectionId="projects"
        onEvent={onEvent}
        onItemContextMenu={onItemContextMenu}
        renaming={options.renaming}
        onRenameEnd={onRenameEnd}
      />
    </ul>,
  );
  return { onEvent, onItemContextMenu, onRenameEnd, ...view };
}

describe("WorktreeRow", () => {
  beforeEach(() => {
    vi.mocked(openUrl).mockResolvedValue(undefined);
    branchStatusMock.mockResolvedValue({
      ghAvailable: true,
      repo: "owner/repo",
      pushed: true,
      worktreeBroken: false,
      prs: [],
    });
    checksMock.mockResolvedValue({
      ghAvailable: true,
      repo: "owner/repo",
      conclusion: "success",
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
      checks: [],
    });
  });

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

  it("renders removing status without actions", () => {
    const { onEvent } = harness(
      wt({ pendingState: "removing", label: "wip" }),
    );
    expect(screen.getByText(/removing/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
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

  it("renders a compact PR badge when GitHub reports a matching PR", async () => {
    branchStatusMock.mockResolvedValueOnce({
      ghAvailable: true,
      repo: "owner/repo",
      pushed: true,
      worktreeBroken: false,
      prs: [
        {
          number: 42,
          state: "OPEN",
          title: "Feature X",
          url: "https://github.test/pr/42",
          isDraft: false,
          merged: false,
          baseRefName: "main",
        },
      ],
    });
    checksMock.mockResolvedValueOnce({
      ghAvailable: true,
      repo: "owner/repo",
      conclusion: "pending",
      total: 1,
      passed: 0,
      failed: 0,
      pending: 1,
      skipped: 0,
      checks: [],
    });
    harness(wt());
    await waitFor(() => expect(screen.getByText("open #42")).toBeTruthy());
    expect(screen.getByLabelText(/Open PR #42/)).toBeTruthy();
    expect(
      document.querySelector(".ae-worktree-pr-ci--pending"),
    ).toBeTruthy();
  });

  it("opens PR badge links in the user's browser without switching worktrees", async () => {
    branchStatusMock.mockResolvedValueOnce({
      ghAvailable: true,
      repo: "owner/repo",
      pushed: true,
      worktreeBroken: false,
      prs: [
        {
          number: 42,
          state: "OPEN",
          title: "Feature X",
          url: "https://github.test/pr/42",
          isDraft: false,
          merged: false,
          baseRefName: "main",
        },
      ],
    });
    checksMock.mockResolvedValueOnce({
      ghAvailable: true,
      repo: "owner/repo",
      conclusion: "success",
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
      checks: [],
    });
    const { onEvent } = harness(wt());
    const badge = await screen.findByLabelText(/Open PR #42/);

    fireEvent.click(badge);

    expect(openUrl).toHaveBeenCalledWith("https://github.test/pr/42");
    expect(onEvent).not.toHaveBeenCalledWith(
      "switch-worktree",
      expect.anything(),
      expect.anything(),
    );

    fireEvent.doubleClick(badge);
    expect(onEvent).not.toHaveBeenCalledWith(
      "open-worktree-in-new-tab",
      expect.anything(),
      expect.anything(),
    );
  });

  it("periodically polls PR and CI badges through the cache getters", async () => {
    vi.useFakeTimers();
    branchStatusMock
      .mockResolvedValueOnce({
        ghAvailable: true,
        repo: "owner/repo",
        pushed: true,
        worktreeBroken: false,
        prs: [
          {
            number: 42,
            state: "OPEN",
            title: "Feature X",
            url: "https://github.test/pr/42",
            isDraft: false,
            merged: false,
            baseRefName: "main",
          },
        ],
      })
      .mockResolvedValueOnce({
        ghAvailable: true,
        repo: "owner/repo",
        pushed: true,
        worktreeBroken: false,
        prs: [
          {
            number: 42,
            state: "CLOSED",
            title: "Feature X",
            url: "https://github.test/pr/42",
            isDraft: false,
            merged: true,
            baseRefName: "main",
          },
        ],
      });
    checksMock
      .mockResolvedValueOnce({
        ghAvailable: true,
        repo: "owner/repo",
        conclusion: "pending",
        total: 1,
        passed: 0,
        failed: 0,
        pending: 1,
        skipped: 0,
        checks: [],
      })
      .mockResolvedValueOnce({
        ghAvailable: true,
        repo: "owner/repo",
        conclusion: "success",
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        skipped: 0,
        checks: [],
      });

    harness(wt());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("open #42")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKTREE_PENDING_CI_REFRESH_MS);
    });

    expect(branchStatusMock).toHaveBeenCalledTimes(2);
    expect(branchStatusMock).toHaveBeenLastCalledWith(
      "/repo-feature-x",
      "feature-x",
    );
    expect(checksMock).toHaveBeenCalledTimes(2);
    expect(checksMock).toHaveBeenLastCalledWith(
      "/repo-feature-x",
      "feature-x",
    );
    expect(screen.getByText("merged #42")).toBeTruthy();
    expect(
      document.querySelector(".ae-worktree-pr-ci--success"),
    ).toBeTruthy();
  });

  it("does not show an empty PR slot during background refreshes without a PR", async () => {
    vi.useFakeTimers();
    branchStatusMock.mockResolvedValue({
      ghAvailable: true,
      repo: "owner/repo",
      pushed: true,
      worktreeBroken: false,
      prs: [],
    });

    harness(wt());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector(".ae-worktree-pr-slot")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKTREE_PR_REFRESH_MS);
    });

    expect(branchStatusMock).toHaveBeenCalledTimes(2);
    expect(checksMock).not.toHaveBeenCalled();
    expect(document.querySelector(".ae-worktree-pr-slot")).toBeNull();
  });

  it("does not fetch CI checks when there is no PR to summarize", async () => {
    harness(wt());

    await waitFor(() => expect(branchStatusMock).toHaveBeenCalled());
    expect(checksMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/#/)).toBeNull();
  });

  it("opens inline confirmation from the remove icon", () => {
    const { onEvent } = harness(wt({ label: "feature-x" }));
    const row = screen.getByText("feature-x").closest("li")!;
    fireEvent.click(screen.getByRole("button", { name: "Remove feature-x" }));
    expect(onEvent).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Confirm remove feature-x" }).textContent,
    ).toBe("Confirm");
    fireEvent.click(row);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("confirms inline worktree removal without switching rows", () => {
    const { onEvent } = harness(wt({ label: "feature-x" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove feature-x" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm remove feature-x" }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      "remove-worktree",
      expect.objectContaining({ worktreeId: "wt-1", confirmed: true }),
      "wt-1",
    );
  });

  it("clears inline remove confirmation when the pointer leaves", () => {
    const { onEvent } = harness(wt({ label: "feature-x" }));
    const row = screen.getByText("feature-x").closest("li")!;
    fireEvent.click(screen.getByRole("button", { name: "Remove feature-x" }));
    fireEvent.mouseLeave(row);
    expect(
      screen.queryByRole("button", { name: "Confirm remove feature-x" }),
    ).toBeNull();
    fireEvent.click(row);
    expect(onEvent).toHaveBeenCalledWith(
      "switch-worktree",
      expect.objectContaining({ worktreeId: "wt-1" }),
      "wt-1",
    );
  });

  it("does not show inline remove for the main worktree", () => {
    harness(wt({ isMain: true, label: "main" }));
    expect(screen.queryByRole("button", { name: "Remove main" })).toBeNull();
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

  it("renders an inline rename input when rename mode begins", () => {
    const { rerender } = harness(wt({ label: "Display name", branch: "feat/x" }));

    rerender(
      <ul>
        <WorktreeRow
          item={wt({ label: "Display name", branch: "feat/x" })}
          sectionId="projects"
          onEvent={vi.fn()}
          renaming
        />
      </ul>,
    );

    const input = screen.getByRole("textbox", { name: /rename worktree/i });
    expect((input as HTMLInputElement).value).toBe("Display name");
    expect(document.activeElement).toBe(input);
  });

  it("saves inline rename on Enter", () => {
    const { onEvent, onRenameEnd } = harness(wt(), { renaming: true });
    const input = screen.getByRole("textbox", { name: /rename worktree/i });

    fireEvent.change(input, { target: { value: "Renamed worktree" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEvent).toHaveBeenCalledWith(
      "rename-worktree",
      expect.objectContaining({
        sectionId: "projects",
        worktreeId: "wt-1",
        label: "Renamed worktree",
      }),
      "wt-1",
    );
    expect(onRenameEnd).toHaveBeenCalledWith("wt-1");
  });

  it("cancels inline rename on Escape", () => {
    const { onEvent, onRenameEnd } = harness(wt(), { renaming: true });
    const input = screen.getByRole("textbox", { name: /rename worktree/i });

    fireEvent.change(input, { target: { value: "Renamed worktree" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onEvent).not.toHaveBeenCalledWith(
      "rename-worktree",
      expect.anything(),
      expect.anything(),
    );
    expect(onRenameEnd).toHaveBeenCalledWith("wt-1");
  });

  it("cancels inline rename on blur", () => {
    vi.useFakeTimers();
    const { onEvent, onRenameEnd } = harness(wt(), { renaming: true });
    const input = screen.getByRole("textbox", { name: /rename worktree/i });
    act(() => {
      vi.runAllTimers();
    });

    fireEvent.change(input, { target: { value: "Renamed worktree" } });
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    act(() => {
      vi.runAllTimers();
    });

    expect(onEvent).not.toHaveBeenCalledWith(
      "rename-worktree",
      expect.anything(),
      expect.anything(),
    );
    expect(onRenameEnd).toHaveBeenCalledWith("wt-1");
  });

  it("ends inline rename when a blurred row unmounts", () => {
    vi.useFakeTimers();
    const { onRenameEnd, unmount } = harness(wt(), { renaming: true });
    expect(screen.getByRole("textbox", { name: /rename worktree/i })).toBeTruthy();
    act(() => {
      vi.runAllTimers();
    });

    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    unmount();
    act(() => {
      vi.runAllTimers();
    });

    expect(onRenameEnd).toHaveBeenCalledWith("wt-1");
  });

  it("does not cancel rename during StrictMode effect replay", () => {
    vi.useFakeTimers();
    const onRenameEnd = vi.fn();
    render(
      <StrictMode>
        <ul>
          <WorktreeRow
            item={wt()}
            sectionId="projects"
            onEvent={vi.fn()}
            renaming
            onRenameEnd={onRenameEnd}
          />
        </ul>
      </StrictMode>,
    );

    act(() => {
      vi.runAllTimers();
    });

    expect(screen.getByRole("textbox", { name: /rename worktree/i })).toBeTruthy();
    expect(onRenameEnd).not.toHaveBeenCalled();
  });

  it("does not interrupt typed rename text across parent re-renders", () => {
    const { onEvent, onRenameEnd, rerender } = harness(wt(), {
      renaming: true,
    });
    const input = screen.getByRole("textbox", { name: /rename worktree/i });
    fireEvent.change(input, { target: { value: "half typed" } });

    rerender(
      <ul>
        <WorktreeRow
          item={wt({ label: "fresh from parent" })}
          sectionId="projects"
          onEvent={onEvent}
          renaming
          onRenameEnd={onRenameEnd}
        />
      </ul>,
    );

    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: /rename worktree/i })
        .value,
    ).toBe("half typed");
  });

  it("does not enter rename mode for pending or failed rows", () => {
    harness(wt({ pendingState: "starting" }), { renaming: true });
    expect(
      screen.queryByRole("textbox", { name: /rename worktree/i }),
    ).toBeNull();
    cleanup();

    harness(wt({ pendingState: "removing" }), { renaming: true });
    expect(
      screen.queryByRole("textbox", { name: /rename worktree/i }),
    ).toBeNull();
    cleanup();

    harness(wt({ pendingState: "failed" }), { renaming: true });
    expect(
      screen.queryByRole("textbox", { name: /rename worktree/i }),
    ).toBeNull();
  });
});
