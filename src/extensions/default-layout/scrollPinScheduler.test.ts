// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtuosoHandle } from "react-virtuoso";
import { createScrollPinScheduler } from "./scrollPinScheduler";

function setScrollerMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
) {
  Object.defineProperties(el, {
    scrollHeight: { value: metrics.scrollHeight, configurable: true },
    clientHeight: { value: metrics.clientHeight, configurable: true },
    scrollTop: { value: metrics.scrollTop, writable: true, configurable: true },
  });
}

function createVirtuosoMock() {
  const scrollTo = vi.fn();
  const scrollToIndex = vi.fn();
  const virtuoso = { scrollTo, scrollToIndex } as unknown as VirtuosoHandle;
  return { scrollTo, scrollToIndex, virtuoso };
}

let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn>;
let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn>;
let clearTimeoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  requestAnimationFrameSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockReturnValue(1);
  cancelAnimationFrameSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation(() => {});
  clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
});

afterEach(() => {
  requestAnimationFrameSpy.mockRestore();
  cancelAnimationFrameSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
  vi.useRealTimers();
});

describe("scrollPinScheduler", () => {
  it("coalesces animation-frame pinning while replacing delayed pins", () => {
    const scroller = document.createElement("div");
    setScrollerMetrics(scroller, {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 0,
    });
    const { scrollTo, scrollToIndex, virtuoso } = createVirtuosoMock();
    const scheduler = createScrollPinScheduler({
      getScroller: () => scroller,
      getRowsLength: () => 4,
      getVirtuoso: () => virtuoso,
      isFollowing: () => true,
      updateCanScroll: vi.fn(),
    });

    scheduler.schedulePin(900);
    scheduler.schedulePin(900);

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenLastCalledWith({
      index: 3,
      align: "end",
    });
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: Number.MAX_SAFE_INTEGER,
    });

    // The second schedule keeps the pending RAF and replaces the delayed
    // settle timers from the first schedule.
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(5);
  });

  it("cancels pending animation-frame and delayed pins", () => {
    const scroller = document.createElement("div");
    setScrollerMetrics(scroller, {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 0,
    });
    const { scrollTo, virtuoso } = createVirtuosoMock();
    const scheduler = createScrollPinScheduler({
      getScroller: () => scroller,
      getRowsLength: () => 2,
      getVirtuoso: () => virtuoso,
      isFollowing: () => true,
      updateCanScroll: vi.fn(),
    });

    scheduler.schedulePin(900);
    scheduler.cancel();
    vi.advanceTimersByTime(900);

    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(1);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("resets the settle deadline on cancel before future schedules", () => {
    const callbacks: FrameRequestCallback[] = [];
    requestAnimationFrameSpy.mockImplementation(
      (callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
    );
    const scroller = document.createElement("div");
    setScrollerMetrics(scroller, {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 0,
    });
    const { virtuoso } = createVirtuosoMock();
    const scheduler = createScrollPinScheduler({
      getScroller: () => scroller,
      getRowsLength: () => 2,
      getVirtuoso: () => virtuoso,
      isFollowing: () => true,
      updateCanScroll: vi.fn(),
    });

    scheduler.schedulePin(900);
    scheduler.cancel();
    scheduler.schedulePin(50);
    vi.advanceTimersByTime(60);
    callbacks[1]?.(60);

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(2);
  });

  it("does not run delayed pins after follow is disabled", () => {
    const scroller = document.createElement("div");
    setScrollerMetrics(scroller, {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 0,
    });
    const { scrollTo, virtuoso } = createVirtuosoMock();
    let following = true;
    const scheduler = createScrollPinScheduler({
      getScroller: () => scroller,
      getRowsLength: () => 2,
      getVirtuoso: () => virtuoso,
      isFollowing: () => following,
      updateCanScroll: vi.fn(),
    });

    scheduler.schedulePin(900);
    following = false;
    vi.advanceTimersByTime(900);

    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});
