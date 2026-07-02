// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  clearChromeBootSnapshot,
  readChromeBootSnapshot,
  shouldPaintChromeOptimistically,
  writeChromeBootSnapshot,
  type ChromeBootSnapshot,
} from "./chromeBootSnapshot";

const KEY = __testing.STORAGE_KEY;

const builtinsOnly: ChromeBootSnapshot = {
  customLayout: false,
  frontendModules: false,
  extTheme: false,
};

describe("chromeBootSnapshot", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    __testing.reset();
  });

  it("round-trips a built-ins-only snapshot and paints optimistically", () => {
    writeChromeBootSnapshot(builtinsOnly, { optimisticChrome: true });
    expect(readChromeBootSnapshot()).toEqual(builtinsOnly);
    expect(shouldPaintChromeOptimistically()).toBe(true);
  });

  it("does not paint optimistically when a custom layout was recorded", () => {
    writeChromeBootSnapshot(
      { ...builtinsOnly, customLayout: true },
      { optimisticChrome: true },
    );
    expect(shouldPaintChromeOptimistically()).toBe(false);
  });

  it("does not paint optimistically when frontend modules were recorded", () => {
    writeChromeBootSnapshot(
      { ...builtinsOnly, frontendModules: true },
      { optimisticChrome: true },
    );
    expect(shouldPaintChromeOptimistically()).toBe(false);
  });

  it("does not paint optimistically when an extension theme was active", () => {
    writeChromeBootSnapshot(
      { ...builtinsOnly, extTheme: true },
      { optimisticChrome: true },
    );
    expect(shouldPaintChromeOptimistically()).toBe(false);
  });

  it("returns false and null when no snapshot exists", () => {
    expect(readChromeBootSnapshot()).toBeNull();
    expect(shouldPaintChromeOptimistically()).toBe(false);
  });

  it("treats malformed JSON as absent", () => {
    localStorage.setItem(KEY, "{ not valid json");
    expect(readChromeBootSnapshot()).toBeNull();
    expect(shouldPaintChromeOptimistically()).toBe(false);
  });

  it("treats a wrong-shaped record as absent", () => {
    localStorage.setItem(KEY, JSON.stringify({ customLayout: "yes" }));
    expect(readChromeBootSnapshot()).toBeNull();
    expect(shouldPaintChromeOptimistically()).toBe(false);
  });

  it("kill-switch off clears any stored snapshot at write time", () => {
    writeChromeBootSnapshot(builtinsOnly, { optimisticChrome: true });
    expect(readChromeBootSnapshot()).not.toBeNull();
    // A subsequent write with the kill-switch off removes the record so the
    // next boot can't paint optimistically off a stale snapshot.
    writeChromeBootSnapshot(builtinsOnly, { optimisticChrome: false });
    expect(readChromeBootSnapshot()).toBeNull();
    expect(shouldPaintChromeOptimistically()).toBe(false);
  });

  it("clearChromeBootSnapshot removes the record", () => {
    writeChromeBootSnapshot(builtinsOnly, { optimisticChrome: true });
    clearChromeBootSnapshot();
    expect(readChromeBootSnapshot()).toBeNull();
  });

  it("never throws when storage is unavailable", () => {
    __testing.setStorage(null);
    expect(() =>
      writeChromeBootSnapshot(builtinsOnly, { optimisticChrome: true }),
    ).not.toThrow();
    expect(readChromeBootSnapshot()).toBeNull();
    expect(shouldPaintChromeOptimistically()).toBe(false);
    expect(() => clearChromeBootSnapshot()).not.toThrow();
  });

  it("swallows storage setItem failures", () => {
    const throwing: Storage = {
      length: 0,
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    __testing.setStorage(throwing);
    expect(() =>
      writeChromeBootSnapshot(builtinsOnly, { optimisticChrome: true }),
    ).not.toThrow();
  });
});
