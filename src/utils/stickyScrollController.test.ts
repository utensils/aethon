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
    c.onContentChanged(); // decision says scroll
    // Hook tells the controller it actually moved the container.
    c.notifyProgrammaticScroll();
    // First scroll event after a programmatic scroll is consumed.
    const followAfter = c.onScroll(M(500, 200, 1100));
    expect(followAfter).toBe(true);
  });

  it("does NOT silently suppress real user scrolls when the programmatic scroll was a no-op (codex P2)", () => {
    // Regression: when the container is already at the bottom, the hook
    // writes `el.scrollTop = el.scrollHeight` but the browser clamps it
    // to `scrollHeight - clientHeight` (the actual max), which is the
    // current value — so no scroll event fires. Setting
    // programmaticPending unconditionally would leave the flag stale and
    // suppress the user's NEXT real scroll-away. The hook detects this
    // by reading scrollTop after the assignment and only calls
    // notifyProgrammaticScroll when it actually moved.
    const c = new StickyScrollController();
    c.onContentChanged(); // returns scrollToBottom: true
    // Hook does the write, sees scrollTop didn't change, does NOT call
    // notifyProgrammaticScroll. User then scrolls away.
    const follow = c.onScroll(M(0, 200, 1000));
    expect(follow).toBe(false);
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
    c.onContentChanged();
    c.notifyProgrammaticScroll();
    c.onScroll(M(900, 200, 1100)); // consumes the programmatic flag
    expect(c.follow).toBe(true);
    // Now a genuine user scroll should be honoured.
    c.onScroll(M(0, 200, 1100));
    expect(c.follow).toBe(false);
  });
});
