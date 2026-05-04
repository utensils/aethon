import { describe, expect, it, vi } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
} from "./state";
import {
  ackMutation,
  awaitFrontendReady,
  markFrontendReady,
  trackMutation,
} from "./mutation-ack";

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

function makeState() {
  return new AethonAgentState(baseOpts);
}

describe("mutation-ack", () => {
  describe("markFrontendReady", () => {
    it("flips frontendReady and resolves awaiters", async () => {
      const s = makeState();
      const ready = awaitFrontendReady(s);
      expect(s.frontendReady).toBe(false);
      markFrontendReady(s);
      expect(s.frontendReady).toBe(true);
      await expect(ready).resolves.toBe(true);
    });

    it("is idempotent", () => {
      const s = makeState();
      markFrontendReady(s);
      markFrontendReady(s);
      expect(s.frontendReady).toBe(true);
    });
  });

  describe("trackMutation", () => {
    it("pre-ready mutations resolve immediately with ok:true", async () => {
      const s = makeState();
      const { id, promise } = trackMutation(s);
      expect(id).toMatch(/^m/);
      // No pending entry created — pre-ready short-circuit.
      expect(s.pendingMutations.size).toBe(0);
      await expect(promise).resolves.toEqual({ ok: true });
    });

    it("post-ready mutations stay pending until acked", async () => {
      const s = makeState();
      markFrontendReady(s);
      const { id, promise } = trackMutation(s);
      expect(s.pendingMutations.has(id)).toBe(true);
      ackMutation(s, id, true);
      await expect(promise).resolves.toEqual({ ok: true });
      expect(s.pendingMutations.has(id)).toBe(false);
    });

    it("post-ready mutations time out with ok:false, error:timeout", async () => {
      vi.useFakeTimers();
      try {
        const s = makeState();
        markFrontendReady(s);
        const { id, promise } = trackMutation(s, 50);
        expect(s.pendingMutations.has(id)).toBe(true);
        vi.advanceTimersByTime(60);
        await expect(promise).resolves.toEqual({
          ok: false,
          error: "timeout",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("ackMutation can carry an error string", async () => {
      const s = makeState();
      markFrontendReady(s);
      const { id, promise } = trackMutation(s);
      ackMutation(s, id, false, "frontend_rejected");
      await expect(promise).resolves.toEqual({
        ok: false,
        error: "frontend_rejected",
      });
    });

    it("ackMutation can carry data for query-style mutations", async () => {
      const s = makeState();
      markFrontendReady(s);
      const { id, promise } = trackMutation(s);
      ackMutation(s, id, true, undefined, { tabs: ["a", "b"] });
      await expect(promise).resolves.toEqual({
        ok: true,
        data: { tabs: ["a", "b"] },
      });
    });

    it("ackMutation on an unknown id is a no-op", () => {
      const s = makeState();
      markFrontendReady(s);
      ackMutation(s, "no-such-id", true);
      // Doesn't throw, doesn't mutate anything.
      expect(s.pendingMutations.size).toBe(0);
    });
  });

  describe("awaitFrontendReady", () => {
    it("returns true immediately if already ready", async () => {
      const s = makeState();
      markFrontendReady(s);
      await expect(awaitFrontendReady(s)).resolves.toBe(true);
      await expect(awaitFrontendReady(s, 1)).resolves.toBe(true);
    });

    it("returns false after timeoutMs if frontend never reports", async () => {
      vi.useFakeTimers();
      try {
        const s = makeState();
        const result = awaitFrontendReady(s, 50);
        vi.advanceTimersByTime(60);
        await expect(result).resolves.toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("blocks indefinitely with no timeout until markFrontendReady fires", async () => {
      const s = makeState();
      let resolved = false;
      const result = awaitFrontendReady(s).then((v) => {
        resolved = true;
        return v;
      });
      // Yield once — should still be unresolved.
      await Promise.resolve();
      expect(resolved).toBe(false);
      markFrontendReady(s);
      await expect(result).resolves.toBe(true);
    });
  });
});
