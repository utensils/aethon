import { describe, expect, it } from "vitest";
import { handleNotifications } from "./notifications";
import { buildRouteFixture } from "./testFixtures";

describe("handleNotifications", () => {
  it("dismiss resolves all three consents defensively and dismisses", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleNotifications(
      {
        component: { id: "notification-stack" },
        eventType: "dismiss",
        data: { id: "ext-1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.resolveShellWriteConsent).toHaveBeenCalledWith("ext-1", false);
    expect(mocks.resolveShellCloseConsent).toHaveBeenCalledWith("ext-1", false);
    expect(mocks.resolveSessionDeleteConsent).toHaveBeenCalledWith(
      "ext-1",
      false,
    );
    expect(mocks.dismissNotification).toHaveBeenCalledWith("ext-1");
  });

  it("ae-agent-crashed:restart invokes start_agent", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleNotifications(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: { id: "n1", action: "ae-agent-crashed:restart" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("start_agent");
    expect(mocks.dismissNotification).toHaveBeenCalledWith("n1");
  });

  it("hang-warn:stop:<tabId> stops that tab specifically", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleNotifications(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: { id: "n2", action: "hang-warn:stop:tab-xyz" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.stopPrompt).toHaveBeenCalledWith("tab-xyz");
    expect(mocks.dismissNotification).toHaveBeenCalledWith("n2");
  });

  it("hang-warn:force-restart invokes force_restart_agent", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleNotifications(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: { id: "n3", action: "hang-warn:force-restart" },
      },
      ctx,
    );
    expect(mocks.invoke).toHaveBeenCalledWith("force_restart_agent");
  });

  it("forwards an unknown action through dispatch_a2ui_event", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { activeTabId: "tab-active" },
    });
    await handleNotifications(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: { id: "n4", action: "ext:custom" },
      },
      ctx,
    );
    const [cmd, args] = mocks.invoke.mock.calls[0];
    expect(cmd).toBe("dispatch_a2ui_event");
    const event = JSON.parse((args as { event: string }).event);
    expect(event).toMatchObject({
      componentId: "notification__tpl__n4",
      componentType: "notification",
      eventType: "invoke",
      data: { id: "n4", action: "ext:custom" },
    });
    expect((args as { tabId: string }).tabId).toBe("tab-active");
  });

  it("returns false for non-notification-stack components", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleNotifications(
      { component: { id: "settings-panel" }, eventType: "action" },
      ctx,
    );
    expect(handled).toBe(false);
  });
});
