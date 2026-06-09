import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetWarmRootsForTesting,
  COLD_POLL_INTERVAL_MS,
  dueStatusRoots,
  recordWorkspaceActivation,
  WARM_POLL_INTERVAL_MS,
  WARM_ROOTS_MAX,
  warmStatusRoots,
} from "./statusPollScheduler";

describe("dueStatusRoots", () => {
  const NOW = 1_000_000_000;

  it("polls everything on a cold cache", () => {
    expect(
      dueStatusRoots({
        coldRoots: ["/a", "/b"],
        warmRoots: ["/wt"],
        lastPolledAt: new Map(),
        now: NOW,
      }),
    ).toEqual(["/wt", "/a", "/b"]);
  });

  it("applies the warm cadence to warm roots and cold to the rest", () => {
    const last = new Map([
      ["/wt", NOW - WARM_POLL_INTERVAL_MS], // warm, due
      ["/wt2", NOW - WARM_POLL_INTERVAL_MS + 1_000], // warm, not yet
      ["/a", NOW - COLD_POLL_INTERVAL_MS], // cold, due
      ["/b", NOW - COLD_POLL_INTERVAL_MS + 1_000], // cold, not yet
    ]);
    expect(
      dueStatusRoots({
        coldRoots: ["/a", "/b"],
        warmRoots: ["/wt", "/wt2"],
        lastPolledAt: last,
        now: NOW,
      }),
    ).toEqual(["/wt", "/a"]);
  });

  it("a root in both tiers polls at the warm cadence", () => {
    const last = new Map([["/a", NOW - WARM_POLL_INTERVAL_MS - 1]]);
    expect(
      dueStatusRoots({
        coldRoots: ["/a"],
        warmRoots: ["/a"],
        lastPolledAt: last,
        now: NOW,
      }),
    ).toEqual(["/a"]);
    // ...and is NOT re-listed or polled twice.
    expect(
      dueStatusRoots({
        coldRoots: ["/a"],
        warmRoots: ["/a"],
        lastPolledAt: new Map([["/a", NOW - 10_000]]),
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe("warm-roots MRU", () => {
  beforeEach(() => __resetWarmRootsForTesting());

  it("keeps the most recent activations, deduped, capped", () => {
    for (let i = 0; i < WARM_ROOTS_MAX + 2; i++) {
      recordWorkspaceActivation(`/p${i}`);
    }
    recordWorkspaceActivation("/p3"); // re-activate -> moves to front
    recordWorkspaceActivation(null);
    recordWorkspaceActivation("");

    const warm = warmStatusRoots();
    expect(warm).toHaveLength(WARM_ROOTS_MAX);
    expect(warm[0]).toBe("/p3");
    expect(warm).not.toContain("/p0");
    expect(warm).not.toContain("/p1");
  });
});
