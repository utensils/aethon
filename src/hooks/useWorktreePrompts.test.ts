// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorktreePrompts } from "./useWorktreePrompts";
import type { NotificationInput } from "./useNotifications";

describe("useWorktreePrompts", () => {
  it("resolves destructive worktree confirmations from notification actions", async () => {
    const pushed: NotificationInput[] = [];
    const { result } = renderHook(() =>
      useWorktreePrompts({
        pushNotification: (input) => {
          pushed.push(input);
        },
      }),
    );

    let settled: boolean | undefined;
    act(() => {
      void result.current.promptForceRemove("dirty worktree").then((value) => {
        settled = value;
      });
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      title: "Force-remove worktree?",
      message: "dirty worktree",
      kind: "warning",
      durationMs: null,
    });
    const id = pushed[0].id;
    expect(id).toMatch(/^worktree-confirm-/);
    expect(pushed[0].actions).toEqual([
      { label: "Force remove", action: `worktree-confirm-allow:${id}` },
      { label: "Cancel", action: `worktree-confirm-deny:${id}` },
    ]);

    act(() => {
      result.current.resolveWorktreePrompt(id!, true);
    });

    await waitFor(() => expect(settled).toBe(true));
  });

  it("surfaces worktree failures as non-blocking notifications", () => {
    const pushNotification = vi.fn();
    const { result } = renderHook(() =>
      useWorktreePrompts({ pushNotification }),
    );

    act(() => {
      result.current.notifyFailure("trash: permission denied");
    });

    expect(pushNotification).toHaveBeenCalledWith({
      title: "Worktree removal failed",
      message: "trash: permission denied",
      kind: "error",
    });
  });
});
