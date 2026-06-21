import { describe, expect, it, vi } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type TabRecord,
} from "./state";
import { handleStop } from "./chat";

const baseOpts: AethonAgentStateOptions = {
  userDir: "/tmp/aethon-test",
  stateFile: "/tmp/aethon-test/state.json",
  sessionsDir: "/tmp/aethon-test/sessions",
  docsDir: undefined,
  projectRoot: undefined,
  releaseMode: false,
  bootLayoutFile: undefined,
  layoutSlotsFile: undefined,
  statePayloadWarnBytes: 64 * 1024,
  statePayloadHardBytes: 512 * 1024,
  statePayloadWarnKb: 64,
  statePayloadHardKb: 512,
};

function fakeRec(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    session: {
      messages: [],
      abort: vi.fn(() => Promise.resolve()),
    } as unknown as TabRecord["session"],
    toolArgsCache: new Map(),
    promptInFlight: true,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
    responseMessageSeq: 0,
    ...overrides,
  };
}

describe("handleStop", () => {
  it("cancels pending context-overflow recovery so stop cannot resume itself", async () => {
    vi.useFakeTimers();
    try {
      const state = new AethonAgentState(baseOpts);
      const sent: Record<string, unknown>[] = [];
      const timerCallback = vi.fn();
      const abortCompaction = vi.fn();
      const rec = fakeRec({
        contextOverflowRecoveryAttempted: true,
        contextOverflowRecoveryInFlight: true,
        contextOverflowRecoveryCompactionStarted: false,
        contextOverflowRecoveryErrorMessage: "context overflow",
        contextOverflowRecoveryTimer: setTimeout(timerCallback, 250),
        session: {
          messages: [],
          abort: vi.fn(() => Promise.resolve()),
          abortCompaction,
        } as unknown as TabRecord["session"],
      });
      state.tabs.set("tab-1", rec);
      state.currentAgentTabId = "tab-1";

      handleStop(
        state,
        { send: (m) => sent.push(m), scheduleStateFileWrite: vi.fn() },
        { type: "stop", tabId: "tab-1" },
      );
      await vi.advanceTimersByTimeAsync(250);

      expect(timerCallback).not.toHaveBeenCalled();
      expect(abortCompaction).toHaveBeenCalledOnce();
      expect(rec.contextOverflowRecoveryInFlight).toBe(false);
      expect(rec.contextOverflowRecoveryTimer).toBeUndefined();
      expect(rec.promptInFlight).toBe(false);
      expect(rec.agentEndFired).toBe(true);
      expect(state.currentAgentTabId).toBeUndefined();
      expect(sent).toContainEqual({ type: "queue_reset", tabId: "tab-1" });
      expect(sent).toContainEqual({ type: "response_end", tabId: "tab-1" });
    } finally {
      vi.useRealTimers();
    }
  });
});
