// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createScrollIntentTracker,
  isUserScrollIntentEvent,
} from "./scrollIntentTracker";

describe("scrollIntentTracker", () => {
  it("distinguishes user scroll intent from programmatic scroll events", () => {
    const onScroll = vi.fn();
    const scroller = document.createElement("div");
    const tracker = createScrollIntentTracker(onScroll);
    tracker.attach(scroller);

    scroller.dispatchEvent(new Event("scroll"));
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(tracker.consumeUserIntent()).toBe(false);

    scroller.dispatchEvent(new WheelEvent("wheel"));
    scroller.dispatchEvent(new Event("scroll"));
    expect(onScroll).toHaveBeenCalledTimes(2);
    expect(tracker.consumeUserIntent()).toBe(true);
    expect(tracker.consumeUserIntent()).toBe(false);
  });

  it("treats only scroll keys outside interactive controls as keyboard intent", () => {
    const scroller = document.createElement("div");
    const input = document.createElement("input");
    scroller.append(input);

    expect(isUserScrollIntentEvent(new KeyboardEvent("keydown", { key: "PageUp" }))).toBe(
      true,
    );
    expect(isUserScrollIntentEvent(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(
      false,
    );
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
    const event = new KeyboardEvent("keydown", { key: "PageDown" });
    Object.defineProperty(event, "target", { value: input });
    expect(isUserScrollIntentEvent(event)).toBe(false);
  });

  it("detaches all listeners", () => {
    const onScroll = vi.fn();
    const scroller = document.createElement("div");
    const tracker = createScrollIntentTracker(onScroll);
    tracker.attach(scroller);
    tracker.detach();

    scroller.dispatchEvent(new WheelEvent("wheel"));
    scroller.dispatchEvent(new Event("scroll"));

    expect(onScroll).not.toHaveBeenCalled();
    expect(tracker.consumeUserIntent()).toBe(false);
  });
});
