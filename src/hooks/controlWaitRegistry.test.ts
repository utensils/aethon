import { describe, expect, it, vi } from "vitest";
import {
  cancelControlWait,
  registerControlWait,
  resolveControlWait,
} from "./controlWaitRegistry";

describe("controlWaitRegistry", () => {
  it("resolves a registered wait when the turn completes", async () => {
    const pending = registerControlWait("req-1", "t1", 10_000);
    expect(resolveControlWait("req-1", "completed", "t1")).toBe(true);
    await expect(pending).resolves.toMatchObject({
      waiting: false,
      outcome: "completed",
      tabId: "t1",
    });
  });

  it("surfaces an error outcome with its message", async () => {
    const pending = registerControlWait("req-2", "t1", 10_000);
    resolveControlWait("req-2", "error", "t1", "boom");
    await expect(pending).resolves.toMatchObject({
      waiting: false,
      outcome: "error",
      error: "boom",
    });
  });

  it("resolves as a timeout when the turn never ends", async () => {
    vi.useFakeTimers();
    try {
      const pending = registerControlWait("req-3", "t1", 1_000);
      vi.advanceTimersByTime(1_001);
      await expect(pending).resolves.toMatchObject({
        waiting: true,
        outcome: "timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op for an unknown id", () => {
    expect(resolveControlWait("never-registered", "completed", "t1")).toBe(
      false,
    );
  });

  it("cancel resolves the waiter as a timeout so it can't leak", async () => {
    const pending = registerControlWait("req-4", "t1", 10_000);
    cancelControlWait("req-4");
    await expect(pending).resolves.toMatchObject({
      waiting: true,
      outcome: "timeout",
    });
  });
});
