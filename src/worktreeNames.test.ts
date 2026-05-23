import { describe, expect, it } from "vitest";

import { _POOL_SIZE_FOR_TESTS, pickWorktreeName } from "./worktreeNames";

describe("pickWorktreeName", () => {
  it("returns a feat/<name> from the helios pool", () => {
    const picked = pickWorktreeName([]);
    expect(picked.startsWith("feat/")).toBe(true);
    expect(picked.length).toBeGreaterThan("feat/".length);
  });

  it("avoids names already in taken (with or without prefix)", () => {
    const taken = ["feat/helios", "phaethon", "feat/orion"];
    for (let i = 0; i < 30; i++) {
      const picked = pickWorktreeName(taken);
      expect(picked).not.toBe("feat/helios");
      expect(picked).not.toBe("feat/phaethon");
      expect(picked).not.toBe("feat/orion");
    }
  });

  it("falls back to <name>-2 / <name>-3 after exhausting the pool", () => {
    // Build a taken-list covering every pool entry — pick must add a suffix.
    const filler: string[] = [];
    for (let i = 0; i < _POOL_SIZE_FOR_TESTS + 5; i++) {
      filler.push(`feat/pool-${i}`);
    }
    // We can't enumerate the pool here, so cover by stamping ALL likely
    // base names: the test asserts the chosen output still parses
    // cleanly even when nothing is "free" in the bare pool.
    const taken = [
      "feat/aethon",
      "feat/phlegon",
      "feat/pyrois",
      "feat/eous",
      "feat/helios",
      "feat/sol",
      "feat/eos",
      "feat/aurora",
      "feat/hyperion",
      "feat/phaethon",
      "feat/selene",
      "feat/luna",
      "feat/boreas",
      "feat/zephyr",
      "feat/notus",
      "feat/eurus",
      "feat/iris",
      "feat/uranus",
      "feat/nyx",
      "feat/hemera",
      "feat/astraeus",
      "feat/asteria",
      "feat/orion",
      "feat/lyra",
      "feat/vega",
      "feat/sirius",
      "feat/altair",
      "feat/rigel",
      "feat/antares",
      "feat/polaris",
    ];
    const picked = pickWorktreeName(taken);
    expect(picked.startsWith("feat/")).toBe(true);
    // After full exhaustion, every result should carry a `-N` suffix.
    expect(picked).toMatch(/-\d+$/);
  });
});
