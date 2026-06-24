const USER_SCROLL_INTENT_EVENTS = [
  "wheel",
  "touchstart",
  "touchmove",
  "pointerdown",
  "keydown",
] as const;

const SCROLL_INTENT_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

function isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest(
      "button,a,input,textarea,select,[role='button'],[role='link'],[role='textbox'],[tabindex]:not([tabindex='-1'])",
    ),
  );
}

export function isUserScrollIntentEvent(event: Event): boolean {
  if (!(event instanceof KeyboardEvent)) return true;
  if (!SCROLL_INTENT_KEYS.has(event.key)) return false;
  if (isInteractiveKeyboardTarget(event.target)) return false;
  return true;
}

export interface ScrollIntentTracker {
  attach(el: HTMLElement): void;
  detach(): void;
  consumeUserIntent(): boolean;
  markUserIntent(event: Event): void;
}

export function createScrollIntentTracker(
  onScroll: EventListener,
): ScrollIntentTracker {
  let el: HTMLElement | null = null;
  let userIntent = false;

  const markUserIntent = (event: Event) => {
    if (isUserScrollIntentEvent(event)) userIntent = true;
  };

  const detach = () => {
    userIntent = false;
    if (!el) return;
    el.removeEventListener("scroll", onScroll);
    for (const eventName of USER_SCROLL_INTENT_EVENTS) {
      el.removeEventListener(eventName, markUserIntent);
    }
    el = null;
  };

  return {
    attach(nextEl) {
      detach();
      el = nextEl;
      nextEl.addEventListener("scroll", onScroll, { passive: true });
      for (const eventName of USER_SCROLL_INTENT_EVENTS) {
        nextEl.addEventListener(eventName, markUserIntent, { passive: true });
      }
    },
    detach,
    consumeUserIntent() {
      const hadIntent = userIntent;
      userIntent = false;
      return hadIntent;
    },
    markUserIntent,
  };
}
