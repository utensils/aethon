/** Routing precedence contract for `dispatchEvent`.
 *
 *  Contract: shell-consent reserved prefixes > extension event-routes
 *  > built-in routes. Any change to the dispatcher must keep these
 *  invariants — they're the security boundary (consent can't be
 *  hijacked) and the extensibility surface (extensions can override
 *  built-ins).
 *
 *  The tests assert via observable side-effects on the route ctx —
 *  whether the consent resolver fired, whether the built-in handler
 *  ran, what the dispatcher's return value was. */
import { describe, expect, it } from "vitest";
import { dispatchEvent } from "./index";
import { buildRouteFixture } from "./testFixtures";

describe("dispatchEvent — precedence contract", () => {
  it("Layer 1 wins over Layer 2: shell-write-allow runs even when an extension matches notification-stack", async () => {
    const { ctx, mocks } = buildRouteFixture({
      pendingShellWriteIds: ["nid-1"],
      // An extension has registered for notification-stack actions —
      // would intercept the event under Layer 2 if Layer 1 didn't win.
      extensionRoutes: [
        { componentId: "notification-stack", eventType: "action" },
      ],
    });
    const handled = await dispatchEvent(
      {
        component: { id: "notification-stack", type: "notification-stack" },
        eventType: "action",
        data: { id: "nid-1", action: "shell-write-allow:req-1" },
      },
      ctx,
    );
    // Handled via consent gate → return true (suppress forward).
    expect(handled).toBe(true);
    expect(mocks.resolveShellWriteConsent).toHaveBeenCalledWith("nid-1", true);
    // The notifications built-in must NOT have run a second resolution
    // pass on top of the consent gate's call.
    expect(mocks.dismissNotification).toHaveBeenCalledTimes(1);
  });

  it("Layer 2 wins over Layer 3: an extension match short-circuits built-ins and returns false (forward to bridge)", async () => {
    const { ctx, mocks } = buildRouteFixture({
      extensionRoutes: [{ componentId: "settings-panel" }],
    });
    const handled = await dispatchEvent(
      {
        component: { id: "settings-panel", type: "settings-panel" },
        eventType: "close",
      },
      ctx,
    );
    // false = renderer forwards to bridge so the extension's
    // aethon.onEvent matcher fires.
    expect(handled).toBe(false);
    // The settings built-in must NOT have run.
    expect(mocks.closeSettings).not.toHaveBeenCalled();
  });

  it("'extension' routing mode forwards every event without running built-ins", async () => {
    const { ctx, mocks } = buildRouteFixture({
      extensionRoutingMode: "extension",
    });
    const handled = await dispatchEvent(
      {
        component: { id: "chat-input", type: "chat-input" },
        eventType: "submit",
        data: { value: "hi" },
      },
      ctx,
    );
    expect(handled).toBe(false);
    expect(mocks.sendChat).not.toHaveBeenCalled();
  });

  it("Layer 3 runs only when no extension matches — built-in chat-input submit fires sendChat", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await dispatchEvent(
      {
        component: { id: "chat-input", type: "chat-input" },
        eventType: "submit",
        data: { value: "hello" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.sendChat).toHaveBeenCalledWith("hello", { mode: "normal" });
  });

  it("Layer 3 lookup uses both id-key and type-key — type-keyed terminal-panel matches even when id differs across layouts", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await dispatchEvent(
      {
        component: { id: "any-layout-terminal", type: "terminal-panel" },
        eventType: "new-shell-sub-tab",
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.newShellTab).toHaveBeenCalledTimes(1);
  });

  it("returns false when nothing matches — renderer falls back to default forward", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await dispatchEvent(
      { component: { id: "unknown-thing" }, eventType: "unknown-event" },
      ctx,
    );
    expect(handled).toBe(false);
  });

  it("Layer 1: dismiss of an id without a pending consent falls through to Layer 3", async () => {
    // No pending consent + no extension route + dismiss arrives → the
    // notifications built-in (Layer 3) handles it as the safety-net
    // resolve-and-dismiss path.
    const { ctx, mocks } = buildRouteFixture();
    const handled = await dispatchEvent(
      {
        component: { id: "notification-stack", type: "notification-stack" },
        eventType: "dismiss",
        data: { id: "stranger" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    // Built-in path called dismissNotification once.
    expect(mocks.dismissNotification).toHaveBeenCalledWith("stranger");
  });
});

/** Type-keyed routing contract — closes the abstraction-integrity gap
 *  identified in the M5/M6 audit. A custom layout payload (or an extension
 *  override) may rename the chrome-composite instance; events should
 *  still route to the correct built-in handler because the route table
 *  keys on `type:`, not `id:`. */
describe("dispatchEvent — chrome composites route by type, not id", () => {
  it("renamed command-palette instance still routes selection", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const item = { kind: "tab" as const, tabId: "abc", label: "tab abc" };
    const handled = await dispatchEvent(
      {
        // An extension swapped command-palette and assigned its own id.
        component: { id: "primary-cmd-deck", type: "command-palette" },
        eventType: "select",
        data: { item },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.runPaletteItem).toHaveBeenCalledWith(item);
  });

  it("renamed sidebar instance still routes select to handleSectionedSelect", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await dispatchEvent(
      {
        component: { id: "primary-side-rail", type: "sidebar" },
        eventType: "select",
        data: { sectionId: "themes", itemId: "ember" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.setTheme).toHaveBeenCalledWith("ember");
  });

  it("renamed settings-panel instance still routes close", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await dispatchEvent(
      {
        component: { id: "config-overlay", type: "settings-panel" },
        eventType: "close",
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.closeSettings).toHaveBeenCalledTimes(1);
  });

  it("renamed search-panel instance still routes close", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await dispatchEvent(
      {
        component: { id: "history-finder", type: "search-panel" },
        eventType: "close",
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.closeSessionSearch).toHaveBeenCalledTimes(1);
  });

  it("renamed notification-stack instance still dismisses", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await dispatchEvent(
      {
        component: { id: "toast-rail", type: "notification-stack" },
        eventType: "dismiss",
        data: { id: "nid-9" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.dismissNotification).toHaveBeenCalledWith("nid-9");
  });

  it("renamed empty-state instance still routes new-tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await dispatchEvent(
      {
        component: { id: "welcome-card", type: "empty-state" },
        eventType: "new-tab",
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.newTab).toHaveBeenCalledTimes(1);
  });

  it("worktree landing routes session restore rows through the built-in restore handler", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: {
        landing: {
          kind: "worktree",
          worktreeId: "wt-1",
          path: "/repo/app-fix",
        },
        activeProjectId: "p1",
        projects: [{ id: "p1", path: "/repo/app" }],
        sidebar: {
          projects: [
            {
              id: "p1",
              worktrees: [{ id: "wt-1", path: "/repo/app-fix" }],
            },
          ],
        },
      },
    });
    const handled = await dispatchEvent(
      {
        component: { id: "worktree-landing", type: "worktree-landing" },
        eventType: "restore-session",
        data: {
          sessionId: "session-1",
          label: "Continue worktree fix",
          cwd: "/repo/app-fix",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.activateWorktree).toHaveBeenCalledWith("wt-1");
    expect(mocks.newTab).toHaveBeenCalledWith(
      "session-1",
      "Continue worktree fix",
      {
        restoredSession: true,
        cwd: "/repo/app-fix",
      },
    );
    expect(applySetState().landing).toBeNull();
  });

  it("worktree landing routes inline session delete confirmations", async () => {
    const { ctx, mocks } = buildRouteFixture({ promptDeleteAllow: true });
    const handled = await dispatchEvent(
      {
        component: { id: "worktree-landing", type: "worktree-landing" },
        eventType: "delete-session",
        data: {
          sessionId: "session-1",
          label: "Continue worktree fix",
          confirmed: true,
        },
      },
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(mocks.promptDeleteSessionConfirmation).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("delete_session", {
      tabId: "session-1",
    });
  });

  it("renamed model-picker instance still routes setModel", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await dispatchEvent(
      {
        component: { id: "header-model-dropdown", type: "model-picker" },
        eventType: "select",
        data: { sectionId: "models", itemId: "anthropic/claude-opus-4-7" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.setModel).toHaveBeenCalledWith("anthropic/claude-opus-4-7");
  });

  it("renamed chat-input instance still routes submit", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await dispatchEvent(
      {
        component: { id: "composer-1", type: "chat-input" },
        eventType: "submit",
        data: { value: "hello" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.sendChat).toHaveBeenCalledWith("hello", { mode: "normal" });
  });
});
