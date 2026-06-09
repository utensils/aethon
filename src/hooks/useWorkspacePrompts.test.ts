// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspacePrompts } from "./useWorkspacePrompts";
import type { NotificationInput } from "./useNotifications";

describe("useWorkspacePrompts", () => {
  it("resolves destructive workspace confirmations from notification actions", async () => {
    const pushed: NotificationInput[] = [];
    const { result } = renderHook(() =>
      useWorkspacePrompts({
        pushNotification: (input) => {
          pushed.push(input);
        },
      }),
    );

    let settled: boolean | undefined;
    act(() => {
      void result.current.promptForceRemove("dirty workspace").then((value) => {
        settled = value;
      });
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      title: "Force-remove workspace?",
      message: "dirty workspace",
      kind: "warning",
      durationMs: null,
    });
    const id = pushed[0].id;
    expect(id).toMatch(/^workspace-confirm-/);
    expect(pushed[0].actions).toEqual([
      { label: "Force remove", action: `workspace-confirm-allow:${id}` },
      { label: "Cancel", action: `workspace-confirm-deny:${id}` },
    ]);

    act(() => {
      result.current.resolveWorkspacePrompt(id!, true);
    });

    await waitFor(() => expect(settled).toBe(true));
  });

  it("surfaces workspace failures as non-blocking notifications", () => {
    const pushNotification = vi.fn();
    const { result } = renderHook(() =>
      useWorkspacePrompts({ pushNotification }),
    );

    act(() => {
      result.current.notifyFailure("trash: permission denied");
    });

    expect(pushNotification).toHaveBeenCalledWith({
      title: "Workspace removal failed",
      message: "trash: permission denied",
      kind: "error",
    });
  });
});
