import type { VirtuosoHandle } from "react-virtuoso";

export interface ScrollPinScheduler {
  schedulePin(settleMs?: number): void;
  pinNow(): void;
  cancel(): void;
}

export interface ScrollPinSchedulerArgs {
  getScroller: () => HTMLElement | null;
  getRowsLength: () => number;
  getVirtuoso: () => VirtuosoHandle | null;
  isFollowing: () => boolean;
  updateCanScroll: () => void;
}

function currentTime(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function createScrollPinScheduler({
  getScroller,
  getRowsLength,
  getVirtuoso,
  isFollowing,
  updateCanScroll,
}: ScrollPinSchedulerArgs): ScrollPinScheduler {
  let pinRaf: number | null = null;
  let pinDeadline = 0;
  let pinTimeouts: number[] = [];

  const cancel = () => {
    if (pinRaf !== null) {
      window.cancelAnimationFrame(pinRaf);
      pinRaf = null;
    }
    for (const timeoutId of pinTimeouts) {
      window.clearTimeout(timeoutId);
    }
    pinTimeouts = [];
  };

  const pinNow = () => {
    const el = getScroller();
    const bottomGap = el
      ? el.scrollHeight - el.clientHeight - el.scrollTop
      : Number.POSITIVE_INFINITY;
    if (bottomGap <= 2) {
      updateCanScroll();
      return;
    }
    const lastIndex = Math.max(0, getRowsLength() - 1);
    const virtuoso = getVirtuoso();
    virtuoso?.scrollToIndex({ index: lastIndex, align: "end" });
    virtuoso?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
    if (el) el.scrollTop = el.scrollHeight;
    updateCanScroll();
  };

  const pinIfStillFollowing = () => {
    if (isFollowing()) pinNow();
  };

  const schedulePin = (settleMs = 150) => {
    const startedAt = currentTime();
    pinDeadline = Math.max(pinDeadline, startedAt + settleMs);
    pinNow();

    const frame = () => {
      pinRaf = null;
      if (!isFollowing()) return;
      pinNow();
      if (currentTime() < pinDeadline) {
        pinRaf = window.requestAnimationFrame(frame);
      }
    };

    if (pinRaf === null) {
      pinRaf = window.requestAnimationFrame(frame);
    }

    for (const timeoutId of pinTimeouts) {
      window.clearTimeout(timeoutId);
    }
    pinTimeouts = [];
    for (const delay of [50, 150, 300, 600, 900]) {
      if (delay <= settleMs) {
        pinTimeouts.push(window.setTimeout(pinIfStillFollowing, delay));
      }
    }
  };

  return { schedulePin, pinNow, cancel };
}
