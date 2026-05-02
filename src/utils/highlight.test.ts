// Vitest stubs the worker import via vi.mock — Vite's `?worker` query is
// not resolvable in node-mode tests. The mock returns a no-op constructor;
// tests exercise only the cache + LRU + reset paths, never round-trip the
// worker. Live highlighting is verified manually in the running app via
// the aethon-debug skill.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../workers/highlight.worker?worker", () => ({
  default: class {
    postMessage(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    terminate(): void {}
  },
}));

import {
  __testing,
  getCachedHighlight,
  highlightCode,
} from "./highlight";

afterEach(() => {
  __testing.reset();
});

describe("getCachedHighlight", () => {
  it("returns null for an unseen (lang, code) pair", () => {
    expect(getCachedHighlight("const x = 1;", "typescript")).toBeNull();
  });

  it("returns the cached HTML when a prior highlight resolved", () => {
    __testing.cache.set(
      "typescript\0const x = 1;",
      '<span class="line">cached</span>',
    );
    expect(getCachedHighlight("const x = 1;", "typescript")).toBe(
      '<span class="line">cached</span>',
    );
  });

  it("trims a single trailing newline before keying so fence-emitted code hits the cache", () => {
    __testing.cache.set(
      "rust\0fn main() {}",
      '<span class="line">cached</span>',
    );
    // Same content, just markdown's closing-fence newline appended.
    expect(getCachedHighlight("fn main() {}\n", "rust")).toBe(
      '<span class="line">cached</span>',
    );
  });

  it("treats different langs with the same code as separate cache entries", () => {
    __testing.cache.set("typescript\0x", "<ts/>");
    __testing.cache.set("python\0x", "<py/>");
    expect(getCachedHighlight("x", "typescript")).toBe("<ts/>");
    expect(getCachedHighlight("x", "python")).toBe("<py/>");
  });
});

describe("highlightCode cache", () => {
  it("resolves immediately from the cache without dispatching a worker request", async () => {
    __testing.cache.set(
      "javascript\0const x = 1;",
      '<span class="line">js</span>',
    );
    await expect(highlightCode("const x = 1;\n", "javascript")).resolves.toBe(
      '<span class="line">js</span>',
    );
    // Synchronous resolution means no entry was queued in pending.
    expect(__testing.pending.size).toBe(0);
  });

  it("LRU-evicts the oldest entry when cache exceeds CACHE_LIMIT (500)", () => {
    // Seed 501 entries with predictable ordering.
    for (let i = 0; i < 501; i++) {
      // Prime via getCachedHighlight to exercise bumpLru's eviction branch
      __testing.cache.set(`text\0entry-${i}`, `html-${i}`);
    }
    // bumpLru fires inside getCachedHighlight on a hit. The cap is enforced
    // by bumpLru, so trigger one hit to force eviction logic.
    expect(__testing.cache.size).toBe(501);
    void getCachedHighlight("entry-500", "text");
    expect(__testing.cache.size).toBe(500);
    // Oldest (entry-0) was evicted; most recent survives.
    expect(__testing.cache.has("text\0entry-0")).toBe(false);
    expect(__testing.cache.has("text\0entry-500")).toBe(true);
  });

  it("reset() empties the cache", () => {
    __testing.cache.set("a\0b", "cached");
    expect(__testing.cache.size).toBe(1);
    __testing.reset();
    expect(__testing.cache.size).toBe(0);
  });
});
