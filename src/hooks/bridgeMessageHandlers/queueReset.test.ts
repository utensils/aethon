import { describe, expect, it } from "vitest";
import { handleQueueReset } from "./queueReset";
import { buildHandlerFixture } from "./testFixtures";

describe("handleQueueReset", () => {
  it("is a no-op — the client-held queue is the source of truth", () => {
    // pi's followUp queue is unused on the new flow; stopPrompt
    // clears the client queue directly. Mutating queueCount from a
    // bridge event would desync the badge from queuedMessages.
    const { ctx, mocks } = buildHandlerFixture();
    handleQueueReset({ type: "queue_reset", tabId: "default" }, ctx);
    handleQueueReset(
      { type: "queue_reset", tabId: "default", queued: 2 },
      ctx,
    );
    expect(mocks.updateTab).not.toHaveBeenCalled();
  });
});
