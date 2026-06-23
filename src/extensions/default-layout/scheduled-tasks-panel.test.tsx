// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTasksPanel } from "./scheduled-tasks-panel";
import type { ScheduledTaskRecord } from "../../scheduledTasks";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

function task(
  overrides: Partial<ScheduledTaskRecord> = {},
): ScheduledTaskRecord {
  return {
    version: 1,
    id: "task-123456789",
    tabId: "tab-1",
    cwd: "/repo",
    model: "openai/gpt-5.5-codex",
    thinkingLevel: null,
    hardEnforce: null,
    authProfileId: null,
    label: "Check new GitHub issues and dispatch sessions",
    prompt: "check issues",
    visiblePrompt: "check issues",
    promptSource: "inline",
    mode: "loopFixed",
    schedule: { kind: "interval", intervalMs: 30 * 60_000, label: "30m" },
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: null,
    lastRunAt: null,
    lastCompletedAt: null,
    expiresAt: Date.now() + 60_000,
    runCount: 0,
    coalescedMisses: 0,
    lastError: null,
    status: "scheduled",
    currentRunId: null,
    ...overrides,
  };
}

function renderPanel(tasks: ScheduledTaskRecord[]) {
  return render(
    <ScheduledTasksPanel
      component={{ id: "scheduled-tasks-panel", type: "scheduled-tasks-panel" }}
      state={{
        activeTabId: "tab-1",
        tabs: [
          { id: "tab-1", kind: "agent" as const, label: "Tab 1", cwd: "/repo" },
        ],
        scheduledTasks: { open: true, tasks },
      }}
      onEvent={() => {}}
    />,
  );
}

describe("ScheduledTasksPanel", () => {
  it("lets fixed loops edit and save their interval from the task row", async () => {
    invokeMock.mockResolvedValue(task());
    renderPanel([task()]);

    fireEvent.change(screen.getByLabelText("Interval"), {
      target: { value: "45m" },
    });
    fireEvent.change(screen.getAllByLabelText("Prompt")[1], {
      target: { value: "updated issue loop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scheduled_task_update", {
        id: "task-123456789",
        patch: {
          mode: "loopFixed",
          prompt: "updated issue loop",
          visiblePrompt: "updated issue loop",
          schedule: {
            kind: "interval",
            intervalMs: 45 * 60_000,
            label: "45m",
          },
        },
      }),
    );
  });

  it("lets existing tasks change type and save the matching interval", async () => {
    invokeMock.mockResolvedValue(task());
    renderPanel([
      task({
        mode: "loopSelfPaced",
        schedule: { kind: "selfPaced" },
      }),
    ]);

    fireEvent.change(screen.getAllByLabelText("Mode")[1], {
      target: { value: "loopFixed" },
    });
    fireEvent.change(screen.getByLabelText("Interval"), {
      target: { value: "5m" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scheduled_task_update", {
        id: "task-123456789",
        patch: {
          mode: "loopFixed",
          schedule: {
            kind: "interval",
            intervalMs: 5 * 60_000,
            label: "5m",
          },
        },
      }),
    );
  });

  it("does not send a schedule patch for prompt-only paused edits", async () => {
    invokeMock.mockResolvedValue(task({ status: "paused" }));
    renderPanel([task({ status: "paused" })]);

    fireEvent.change(screen.getAllByLabelText("Prompt")[1], {
      target: { value: "updated while paused" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scheduled_task_update", {
        id: "task-123456789",
        patch: {
          prompt: "updated while paused",
          visiblePrompt: "updated while paused",
        },
      }),
    );
  });

  it("renders self-paced task prompts as the wide editable field", () => {
    renderPanel([
      task({
        mode: "loopSelfPaced",
        schedule: { kind: "selfPaced" },
        prompt: "long self paced loop prompt",
        visiblePrompt: "long self paced loop prompt",
      }),
    ]);

    const rowPrompt = screen.getAllByLabelText("Prompt")[1];
    expect(rowPrompt.closest("label")?.className).toContain(
      "ae-scheduled-field--wide",
    );
    expect(screen.queryByLabelText("Interval")).toBeNull();
  });
});
