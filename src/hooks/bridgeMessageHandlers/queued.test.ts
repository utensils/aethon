import { describe, expect, it } from "vitest";
import { handleQueued } from "./queued";
import { buildHandlerFixture } from "./testFixtures";

describe("handleQueued", () => {
  it("is a no-op so a stray bridge emission cannot desync the client-held queue badge", () => {
    // Under the client-held queue model, queueCount derives from
    // queuedMessages.length and bridge-driven mutations would
    // corrupt that invariant. Frontend never invokes send_message
    // during a busy turn, so this event effectively never fires —
    // the handler stays registered as a safety net only.
    const { ctx, mocks } = buildHandlerFixture();
    handleQueued({ type: "queued", tabId: "default" }, ctx);
    expect(mocks.updateTab).not.toHaveBeenCalled();
  });
});
