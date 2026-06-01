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

  it("marks retry notices busy so normal sends stay client-queued", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });

    handleNotice(
      {
        type: "notice",
        message: "Transient provider error; retrying 1/3 in 2s.",
        tabId: "default",
        busy: true,
      },
      ctx,
    );

    expect(mocks.updateTab).toHaveBeenCalledWith(
      "default",
      expect.any(Function),
    );
    const update = mocks.updateTab.mock.calls[0][1] as (tab: {
      waiting: boolean;
      queueCount: number;
      queuedMessages: unknown[];
    }) => unknown;
    expect(
      update({ waiting: false, queueCount: 0, queuedMessages: [] }),
    ).toMatchObject({ waiting: true, queueCount: 0 });
    expect(mocks.setStatusFlags).toHaveBeenCalledWith({
      status: "thinking…",
      waiting: true,
    });
  });

  it("ignores empty messages", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleNotice({ type: "notice", message: "" }, ctx);
    expect(mocks.appendMessage).not.toHaveBeenCalled();
    expect(mocks.pushNotification).not.toHaveBeenCalled();
  });
});
