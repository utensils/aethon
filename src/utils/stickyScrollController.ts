/**
 * Pure follow-intent controller behind useStickyScroll. Extracted so the
 * "follow flag updated on user scroll only, never recomputed on content
 * change" rule is testable without React + jsdom.
 *
 * The bug this fixes: a previous version re-read scrollTop / scrollHeight
 * inside the MutationObserver callback. Because mutations have already
 * grown scrollHeight by then, the post-mutation read says "not at bottom"
 * even when the user *was* at the bottom an instant ago — sticky scroll
 * silently breaks for any message taller than the threshold.
 *
 * The fix: track a separate `follow` flag. The flag flips only on
 * user-driven scroll events (we know it's user-driven because the
 * controller did not just programmatically scroll). Content updates do
 * not touch the flag — they just consult it.
 */

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export interface StickyDecision {
  /** Whether the consumer should programmatically scroll to bottom now. */
  scrollToBottom: boolean;
  /** Current follow state — useful for an "isAtBottom" UI indicator. */
  follow: boolean;
}

export const DEFAULT_BOTTOM_THRESHOLD = 60;

export function isAtBottom(metrics: ScrollMetrics, threshold = DEFAULT_BOTTOM_THRESHOLD): boolean {
  return metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - threshold;
}

export class StickyScrollController {
  private followFlag = true;
  // True when the next scroll event reflects a programmatic scroll we
  // just issued — used to ignore that event so we don't accidentally
  // turn off follow on our own auto-scrolls.
  private programmaticPending = false;
  private readonly threshold: number;

  constructor(threshold: number = DEFAULT_BOTTOM_THRESHOLD) {
    this.threshold = threshold;
  }

  get follow(): boolean {
    return this.followFlag;
  }

  /** User scrolled (or the container was scrolled programmatically and the
   *  consumer reported it). Returns the current follow state.
   */
  onScroll(metrics: ScrollMetrics): boolean {
    if (this.programmaticPending) {
      this.programmaticPending = false;
      return this.followFlag;
    }
    this.followFlag = isAtBottom(metrics, this.threshold);
    return this.followFlag;
  }

  /** New content arrived. Decide whether to scroll. The follow flag is
   *  NOT recomputed from current DOM state — that's the fix.
   */
  onContentChanged(): StickyDecision {
    if (this.followFlag) {
      this.programmaticPending = true;
      return { scrollToBottom: true, follow: true };
    }
    return { scrollToBottom: false, follow: false };
  }

  /** User clicked the "scroll to bottom" pill. Re-enable follow. */
  resume(): StickyDecision {
    this.followFlag = true;
    this.programmaticPending = true;
    return { scrollToBottom: true, follow: true };
  }
}
