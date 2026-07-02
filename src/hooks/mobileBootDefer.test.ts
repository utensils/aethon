import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MOBILE_BOOT_DEFER_MS,
  isMobileSurface,
  resetMobileBootWindowForTest,
  scheduleAfterMobileBootWindow,
} from "./mobileBootDefer";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("scheduleAfterMobileBootWindow", () => {
  it("runs immediately on the desktop surface", () => {
    const fn = vi.fn();
    const cancel = scheduleAfterMobileBootWindow(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    cancel(); // no-op — must not throw
  });

  it("defers past the boot window on mobile", () => {
    vi.stubEnv("VITE_AETHON_SURFACE", "mobile");
    vi.useFakeTimers();
    resetMobileBootWindowForTest();
    expect(isMobileSurface()).toBe(true);
    const fn = vi.fn();
    scheduleAfterMobileBootWindow(fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MOBILE_BOOT_DEFER_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires at the END of the window, not a full window from call time", () => {
    vi.stubEnv("VITE_AETHON_SURFACE", "mobile");
    vi.useFakeTimers();
    resetMobileBootWindowForTest();
    // 8s into the window: the deferred run lands at the 10s mark.
    vi.advanceTimersByTime(8_000);
    const fn = vi.fn();
    scheduleAfterMobileBootWindow(fn);
    vi.advanceTimersByTime(MOBILE_BOOT_DEFER_MS - 8_000 - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs immediately when called after the window has passed", () => {
    vi.stubEnv("VITE_AETHON_SURFACE", "mobile");
    vi.useFakeTimers();
    resetMobileBootWindowForTest();
    vi.advanceTimersByTime(MOBILE_BOOT_DEFER_MS + 1);
    const fn = vi.fn();
    scheduleAfterMobileBootWindow(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents a deferred run (unmount before the window)", () => {
    vi.stubEnv("VITE_AETHON_SURFACE", "mobile");
    vi.useFakeTimers();
    resetMobileBootWindowForTest();
    const fn = vi.fn();
    const cancel = scheduleAfterMobileBootWindow(fn);
    cancel();
    vi.advanceTimersByTime(MOBILE_BOOT_DEFER_MS * 2);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("mobileBootWindowElapsed", () => {
  it("is always true on desktop", async () => {
    const { mobileBootWindowElapsed } = await import("./mobileBootDefer");
    expect(mobileBootWindowElapsed()).toBe(true);
  });

  it("flips false -> true across the window on mobile", async () => {
    vi.stubEnv("VITE_AETHON_SURFACE", "mobile");
    vi.useFakeTimers();
    const { mobileBootWindowElapsed, resetMobileBootWindowForTest } =
      await import("./mobileBootDefer");
    resetMobileBootWindowForTest();
    expect(mobileBootWindowElapsed()).toBe(false);
    vi.advanceTimersByTime(MOBILE_BOOT_DEFER_MS + 1);
    expect(mobileBootWindowElapsed()).toBe(true);
  });
});
