import { describe, expect, it } from "vitest";
import {
  StickyScrollController,
  isAtBottom,
} from "./stickyScrollController";

const M = (scrollTop: number, clientHeight: number, scrollHeight: number) =>
  ({ scrollTop, clientHeight, scrollHeight });

describe("isAtBottom", () => {
  it("treats exact-bottom as at-bottom", () => {
    // scrollTop + clientHeight === scrollHeight  →  at bottom
    expect(isAtBottom(M(800, 200, 1000))).toBe(true);
  });

  it("returns false when far from bottom", () => {
    expect(isAtBottom(M(0, 200, 1000))).toBe(false);
  });

  it("respects the threshold so a few pixels short still counts as bottom", () => {
    // 30px short of bottom, threshold defaults to 60.
    expect(isAtBottom(M(770, 200, 1000))).toBe(true);
  });

  it("threshold can be overridden", () => {
    expect(isAtBottom(M(770, 200, 1000), 10)).toBe(false);
  });
});

describe("StickyScrollController", () => {
  it("starts in follow mode so first paint snaps to bottom", () => {
    const c = new StickyScrollController();
    expect(c.follow).toBe(true);
  });

  it("user scrolling away breaks follow", () => {
    const c = new StickyScrollController();
    expect(c.onScroll(M(0, 200, 1000))).toBe(false);
    expect(c.follow).toBe(false);
  });

  it("user scrolling back to bottom restores follow", () => {
    const c = new StickyScrollController();
    c.onScroll(M(0, 200, 1000));
    expect(c.onScroll(M(800, 200, 1000))).toBe(true);
    expect(c.follow).toBe(true);
  });

  it("auto-scrolls when content arrives and follow is on — does NOT recompute scroll position from current DOM", () => {
    const c = new StickyScrollController();
    // No metrics passed to onContentChanged — that's the point of the fix.
    // The controller trusts the follow flag, set during the last user
    // interaction, and ignores whatever scrollHeight is right now.
    const d = c.onContentChanged();
    expect(d.scrollToBottom).toBe(true);
  });

  it("does not auto-scroll if user has scrolled away (follow=false)", () => {
    const c = new StickyScrollController();
    c.onScroll(M(0, 200, 1000));
    const d = c.onContentChanged();
    expect(d.scrollToBottom).toBe(false);
  });

  it("regression: content arrival after user-was-at-bottom does NOT lose follow", () => {
    // The old hook would: user scrolls to bottom → (1000 height) →
    // message arrives → DOM mutation grows scrollHeight to 1100 → hook
    // recomputes "at bottom?" with scrollTop=800, clientHeight=200,
    // scrollHeight=1100 → 1000 < 1040 → atBottom=FALSE → follow lost,
    // user gets stranded. This test asserts the controller does NOT
    // make that mistake — it consults the cached follow flag instead.
    const c = new StickyScrollController();
    c.onScroll(M(800, 200, 1000)); // user at bottom, follow=true
    expect(c.follow).toBe(true);
    // Content grows. We do NOT pass new metrics — the controller must
    // not depend on them for the auto-scroll decision.
    const d = c.onContentChanged();
    expect(d.scrollToBottom).toBe(true);
    expect(c.follow).toBe(true);
  });

  it("ignores the synthesized scroll event from its own programmatic scroll", () => {
    const c = new StickyScrollController();
    // Suppose scrollHeight just grew. Controller will scroll-to-bottom,
    // and the consumer reports that scroll back via onScroll. The new
    // metrics show the user is at the new bottom — but the controller
    // should NOT treat this as a fresh user gesture (that would be
    // benign here, but the symmetric case — user briefly above bottom
    // when our scroll fires — would mistakenly disable follow).
    c.onContentChanged(); // programmatic scroll requested
    // Pretend the consumer's scroll handler fires WHILE the user is
    // momentarily not at the bottom (e.g. between the scroll request
    // and the actual scroll completing). The controller must not flip
    // follow off based on this synthesized event.
    const followAfter = c.onScroll(M(500, 200, 1100));
    expect(followAfter).toBe(true);
  });

  it("resume() forces follow on regardless of prior scroll-away", () => {
    const c = new StickyScrollController();
    c.onScroll(M(0, 200, 1000)); // user away
    expect(c.follow).toBe(false);
    const d = c.resume();
    expect(d.scrollToBottom).toBe(true);
    expect(c.follow).toBe(true);
  });

  it("a real user scroll after a programmatic scroll still updates follow", () => {
    const c = new StickyScrollController();
    c.onContentChanged(); // programmatic-pending = true
    c.onScroll(M(900, 200, 1100)); // consumes the programmatic flag
    expect(c.follow).toBe(true);
    // Now a genuine user scroll should be honoured.
    c.onScroll(M(0, 200, 1100));
    expect(c.follow).toBe(false);
  });
});
