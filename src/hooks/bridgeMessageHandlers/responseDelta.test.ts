import { describe, expect, it } from "vitest";
import { flushResponseDeltas, handleResponseDelta } from "./responseDelta";
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
    flushResponseDeltas("tab-2");
    expect(mocks.appendOrAmendAgentText).toHaveBeenCalledWith(
      "hello",
      "msg-1",
      "tab-2",
      "text",
      undefined,
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
    flushResponseDeltas("default");
    expect(mocks.appendOrAmendAgentText).toHaveBeenCalledWith(
      "x",
      undefined,
      "default",
      "text",
      undefined,
    );
  });

  it("forwards thinking deltas to the thinking channel", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleResponseDelta(
      {
        type: "response_delta",
        content: "plan",
        messageId: "msg-1",
        channel: "thinking",
      },
      ctx,
    );
    flushResponseDeltas("default");
    expect(mocks.appendOrAmendAgentText).toHaveBeenCalledWith(
      "plan",
      "msg-1",
      "default",
      "thinking",
      undefined,
    );
  });

  it("coalesces adjacent deltas for the same message before flushing", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleResponseDelta(
      { type: "response_delta", content: "hel", messageId: "msg-1" },
      ctx,
    );
    handleResponseDelta(
      { type: "response_delta", content: "lo", messageId: "msg-1" },
      ctx,
    );
    expect(mocks.appendOrAmendAgentText).not.toHaveBeenCalled();

    flushResponseDeltas("default");
    expect(mocks.appendOrAmendAgentText).toHaveBeenCalledTimes(1);
    expect(mocks.appendOrAmendAgentText).toHaveBeenCalledWith(
      "hello",
      "msg-1",
      "default",
      "text",
      undefined,
    );
  });

  it("preserves model attribution while coalescing adjacent deltas", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleResponseDelta(
      {
        type: "response_delta",
        content: "hel",
        messageId: "msg-1",
        model: "openai-codex/gpt-5.5",
      },
      ctx,
    );
    handleResponseDelta(
      {
        type: "response_delta",
        content: "lo",
        messageId: "msg-1",
        model: "openai-codex/gpt-5.5",
      },
      ctx,
    );

    flushResponseDeltas("default");
    expect(mocks.appendOrAmendAgentText).toHaveBeenCalledWith(
      "hello",
      "msg-1",
      "default",
      "text",
      "openai-codex/gpt-5.5",
    );
  });
});
