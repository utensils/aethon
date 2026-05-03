import { describe, expect, it } from "vitest";
import { handleResponseDelta } from "./responseDelta";
import { buildHandlerFixture } from "./testFixtures";

describe("handleResponseDelta", () => {
  it("forwards content with messageId + tabId", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleResponseDelta(
      {
        type: "response_delta",
        content: "hello",
        messageId: "msg-1",
        tabId: "tab-2",
      },
      ctx,
    );
    expect(mocks.appendOrAmendAgentText).toHaveBeenCalledWith(
      "hello",
      "msg-1",
      "tab-2",
    );
  });

  it("ignores empty deltas", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleResponseDelta({ type: "response_delta", content: "" }, ctx);
    expect(mocks.appendOrAmendAgentText).not.toHaveBeenCalled();
  });

  it("falls back to default tabId when omitted", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleResponseDelta(
      { type: "response_delta", content: "x" },
      ctx,
    );
    expect(mocks.appendOrAmendAgentText).toHaveBeenCalledWith(
      "x",
      undefined,
      "default",
    );
  });
});
