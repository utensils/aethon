import { describe, expect, it } from "vitest";
import { handleNotificationDismiss } from "./notificationDismiss";
import { buildHandlerFixture } from "./testFixtures";

describe("handleNotificationDismiss", () => {
  it("dismisses by id and acks", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleNotificationDismiss(
      { type: "notification_dismiss", id: "ext-1", mutationId: "m1" },
      ctx,
    );
    expect(mocks.dismissNotification).toHaveBeenCalledWith("ext-1");
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });

  it("skips dismiss when id is missing but still acks", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleNotificationDismiss(
      { type: "notification_dismiss", mutationId: "m2" },
      ctx,
    );
    expect(mocks.dismissNotification).not.toHaveBeenCalled();
    expect(mocks.ackMutation).toHaveBeenCalledWith("m2", true);
  });
});
