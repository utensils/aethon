import { describe, expect, it } from "vitest";
import type { TabRecord } from "./state";
import { isUnderlyingSessionBusy } from "./session-busy";

function fakeTab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    session: { messages: [] } as unknown as TabRecord["session"],
    toolArgsCache: new Map(),
    promptInFlight: false,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
    responseMessageSeq: 0,
    ...overrides,
  };
}

describe("isUnderlyingSessionBusy", () => {
  it("treats context-overflow recovery as an active turn", () => {
    expect(
      isUnderlyingSessionBusy(
        fakeTab({ contextOverflowRecoveryInFlight: true }),
      ),
    ).toBe(true);
  });

  it("keeps existing retry and SDK busy signals", () => {
    expect(isUnderlyingSessionBusy(fakeTab({ aethonRetryInFlight: true }))).toBe(
      true,
    );
    expect(
      isUnderlyingSessionBusy(
        fakeTab({
          session: { isStreaming: true } as unknown as TabRecord["session"],
        }),
      ),
    ).toBe(true);
    expect(
      isUnderlyingSessionBusy(
        fakeTab({
          session: { isRetrying: true } as unknown as TabRecord["session"],
        }),
      ),
    ).toBe(true);
  });

  it("returns false when no underlying recovery or SDK work is active", () => {
    expect(isUnderlyingSessionBusy(fakeTab())).toBe(false);
  });
});
