import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MOBILE_BOOT_DEFER_MS,
  isMobileSurface,
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
    expect(isMobileSurface()).toBe(true);
    const fn = vi.fn();
    scheduleAfterMobileBootWindow(fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MOBILE_BOOT_DEFER_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents a deferred run (unmount before the window)", () => {
    vi.stubEnv("VITE_AETHON_SURFACE", "mobile");
    vi.useFakeTimers();
    const fn = vi.fn();
    const cancel = scheduleAfterMobileBootWindow(fn);
    cancel();
    vi.advanceTimersByTime(MOBILE_BOOT_DEFER_MS * 2);
    expect(fn).not.toHaveBeenCalled();
  });
});
