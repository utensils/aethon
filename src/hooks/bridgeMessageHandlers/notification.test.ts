import { describe, expect, it } from "vitest";
import { handleNotification } from "./notification";
import { buildHandlerFixture } from "./testFixtures";

describe("handleNotification", () => {
  it("forwards a normalized notification and acks", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleNotification(
      {
        type: "notification",
        notification: {
          id: "ext-1",
          title: "Hello",
          message: "world",
          kind: "info",
          durationMs: 4000,
        },
        mutationId: "m1",
      },
      ctx,
    );
    expect(mocks.pushNotification).toHaveBeenCalledWith({
      id: "ext-1",
      title: "Hello",
      message: "world",
      kind: "info",
      durationMs: 4000,
    });
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });

  it("skips push when title is missing but still acks", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleNotification(
      { type: "notification", notification: { message: "no title" }, mutationId: "m2" },
      ctx,
    );
    expect(mocks.pushNotification).not.toHaveBeenCalled();
    expect(mocks.ackMutation).toHaveBeenCalledWith("m2", true);
  });
});
