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
        component: { id: "notification-stack" },
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
      { component: { id: "settings-panel" }, eventType: "close" },
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
        component: { id: "chat-input" },
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
        component: { id: "chat-input" },
        eventType: "submit",
        data: { value: "hello" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.sendChat).toHaveBeenCalledWith("hello");
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
        component: { id: "notification-stack" },
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
