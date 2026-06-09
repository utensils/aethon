import { describe, expect, it } from "vitest";
import { handleNotifications } from "./notifications";
import { buildRouteFixture } from "./testFixtures";

describe("handleNotifications", () => {
  it("dismiss resolves all consents defensively and dismisses", async () => {
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
    expect(mocks.resolveWorkspacePrompt).toHaveBeenCalledWith("ext-1", false);
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

  it("ae-agent-crashed:restart:<tabId> reopens the tab worker", async () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        tabs: [
          {
            id: "tab-worker",
            kind: "agent",
            cwd: "/tmp/project",
            model: "gpt-5",
          },
        ],
      },
    });
    const handled = await handleNotifications(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: {
          id: "n-worker",
          action: "ae-agent-crashed:restart:tab-worker",
        },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "tab_open",
        tabId: "tab-worker",
        cwd: "/tmp/project",
        model: "gpt-5",
      }),
    });
    expect(mocks.dismissNotification).toHaveBeenCalledWith("n-worker");
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

  it("activate-tab:<tabId> jumps to the finished session and dismisses", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleNotifications(
      {
        component: { id: "notification-stack" },
        eventType: "action",
        data: {
          id: "agent-complete:tab-done",
          action: "activate-tab:tab-done",
        },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.activateTabAnywhere).toHaveBeenCalledWith("tab-done");
    expect(mocks.dismissNotification).toHaveBeenCalledWith(
      "agent-complete:tab-done",
    );
    // It must NOT fall through to the generic bridge-forward path.
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "dispatch_a2ui_event",
      expect.anything(),
    );
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

  // Wrong-component rejection is no longer this handler's job — the
  // route table dispatches by `type:notification-stack`, so an event
  // for a different type never reaches handleNotifications. See
  // index.test.ts for the type-keyed routing contract.
});
