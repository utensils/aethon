import { describe, expect, it } from "vitest";
import { handleNotice } from "./notice";
import { buildHandlerFixture } from "./testFixtures";

describe("handleNotice", () => {
  it("appends a system message and pushes a warning toast", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleNotice(
      { type: "notice", message: "queued for follow-up", tabId: "default" },
      ctx,
    );
    expect(mocks.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "system", text: "queued for follow-up" }),
      "default",
    );
    expect(mocks.pushNotification).toHaveBeenCalledWith({
      title: "queued for follow-up",
      kind: "warning",
    });
  });

  it("ignores empty messages", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleNotice({ type: "notice", message: "" }, ctx);
    expect(mocks.appendMessage).not.toHaveBeenCalled();
    expect(mocks.pushNotification).not.toHaveBeenCalled();
  });
});
