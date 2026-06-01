import { describe, expect, it } from "vitest";
import { handleShellConsent, SHELL_CONSENT_PREFIXES } from "./shellConsent";
import { buildRouteFixture } from "./testFixtures";

describe("handleShellConsent", () => {
  it("exposes the canonical reserved prefix list", () => {
    expect(SHELL_CONSENT_PREFIXES).toEqual([
      "shell-write-",
      "shell-close-",
      "session-delete-",
      "worktree-confirm-",
    ]);
  });

  it("shell-write-allow resolves consent to true and dismisses", async () => {
    const { ctx, mocks } = buildRouteFixture({
      pendingShellWriteIds: ["nid-1"],
    });
    const handled = await handleShellConsent(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: { id: "nid-1", action: "shell-write-allow:request-1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.resolveShellWriteConsent).toHaveBeenCalledWith("nid-1", true);
    expect(mocks.dismissNotification).toHaveBeenCalledWith("nid-1");
  });

  it("shell-write-deny resolves consent to false", async () => {
    const { ctx, mocks } = buildRouteFixture({
      pendingShellWriteIds: ["nid-2"],
    });
    await handleShellConsent(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: { id: "nid-2", action: "shell-write-deny:request-2" },
      },
      ctx,
    );
    expect(mocks.resolveShellWriteConsent).toHaveBeenCalledWith("nid-2", false);
  });

  it("dismiss of a pending shell-close id resolves to false", async () => {
    const { ctx, mocks } = buildRouteFixture({
      pendingShellCloseIds: ["nid-3"],
    });
    const handled = await handleShellConsent(
      {
        component: { id: "notification-stack" },
        eventType: "dismiss",
        data: { id: "nid-3" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.resolveShellCloseConsent).toHaveBeenCalledWith("nid-3", false);
  });

  it("session-delete-allow resolves and dismisses", async () => {
    const { ctx, mocks } = buildRouteFixture({
      pendingSessionDeleteIds: ["nid-4"],
    });
    const handled = await handleShellConsent(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: { id: "nid-4", action: "session-delete-allow:abc" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.resolveSessionDeleteConsent).toHaveBeenCalledWith(
      "nid-4",
      true,
    );
  });

  it("worktree-confirm-allow resolves and dismisses", async () => {
    const { ctx, mocks } = buildRouteFixture({
      pendingWorktreePromptIds: ["nid-5"],
    });
    const handled = await handleShellConsent(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: { id: "nid-5", action: "worktree-confirm-allow:nid-5" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.resolveWorktreePrompt).toHaveBeenCalledWith("nid-5", true);
    expect(mocks.dismissNotification).toHaveBeenCalledWith("nid-5");
  });

  it("returns false for non-notification-stack components", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleShellConsent(
      {
        component: { id: "settings-panel" },
        eventType: "action",
        data: { id: "x", action: "shell-write-allow:y" },
      },
      ctx,
    );
    expect(handled).toBe(false);
  });

  it("returns false for an unrelated notification-stack action", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleShellConsent(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: { id: "x", action: "ae-agent-crashed:restart" },
      },
      ctx,
    );
    expect(handled).toBe(false);
  });

  it("returns false for dismiss of an id without a pending resolver", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleShellConsent(
      {
        component: { id: "notification-stack" },
        eventType: "dismiss",
        data: { id: "stranger" },
      },
      ctx,
    );
    expect(handled).toBe(false);
  });
});
