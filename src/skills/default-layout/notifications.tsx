// Notification stack — toast pile rendered at App root, layout-agnostic.
//
// State contract (`/notifications` slice on the main state object): an
// array of NotificationEntry. Auto-expiry is the frontend's job — we
// schedule a setTimeout per entry on first render, fire onEvent("expire"
// {id}) when it fires, and the App-level handler dismisses it. Click
// the toast to dismiss; click an action button to fire the action.
//
// The stack is registered as `notification-stack` in defaultLayoutSkill
// so a skill can override the visual presentation (or place it inside a
// layout cell) — but App.tsx renders the registered component at root
// by default, escaping layout grid clipping.

import { useEffect, useMemo, useRef } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

export type NotificationKind = "info" | "success" | "warning" | "error";

export interface NotificationAction {
  label: string;
  /** Action string fired as `onEvent("action", { id, action })`. The
   *  receiver routes by string; the palette + agent both share this
   *  channel. */
  action: string;
}

export interface NotificationEntry {
  id: string;
  title: string;
  message?: string;
  kind?: NotificationKind;
  /** Auto-dismiss after this many ms. `null`/`undefined` → sticky.
   *  Default for transient toasts is 4000 ms (set at push site, not
   *  here — keeps the renderer pure). */
  durationMs?: number | null;
  actions?: NotificationAction[];
  /** Wall-clock time the entry was created. Used for ordering and
   *  to compute remaining-time on re-renders without resetting the
   *  expiry timer. */
  createdAt: number;
}

const KIND_GLYPH: Record<NotificationKind, string> = {
  info: "ⓘ",
  success: "✓",
  warning: "!",
  error: "✕",
};

export function NotificationStack({ state, onEvent }: BuiltinComponentProps) {
  // Stable identity when /notifications is missing — without the memo,
  // the `?? []` allocates a fresh array each render and the expiry
  // useEffect below sees a new dep on every commit.
  const list = useMemo(
    () => (state.notifications as NotificationEntry[] | undefined) ?? [],
    [state.notifications],
  );

  // Per-id expiry timer. We track which ids already have a timer so a
  // re-render (e.g. another notification arrives) doesn't reset the
  // existing ones. Timers are cleared on unmount AND on dismissal so a
  // sticky+actions notification doesn't leave a zombie callback.
  const timersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    const liveIds = new Set(list.map((n) => n.id));
    // Clear timers for entries that have been dismissed since last
    // render (the entry is gone — its timer should be too).
    for (const [id, handle] of timers.entries()) {
      if (!liveIds.has(id)) {
        window.clearTimeout(handle);
        timers.delete(id);
      }
    }
    // Schedule timers for new entries with a finite duration.
    for (const n of list) {
      if (timers.has(n.id)) continue;
      const dur = n.durationMs;
      if (typeof dur !== "number" || dur <= 0) continue;
      const elapsed = Math.max(0, Date.now() - n.createdAt);
      const remaining = Math.max(0, dur - elapsed);
      const handle = window.setTimeout(() => {
        timers.delete(n.id);
        onEvent("expire", { id: n.id });
      }, remaining);
      timers.set(n.id, handle);
    }
    return () => {
      // unmount: clear all
      for (const handle of timers.values()) window.clearTimeout(handle);
      timers.clear();
    };
  }, [list, onEvent]);

  if (list.length === 0) return null;

  const dismiss = (id: string) => onEvent("dismiss", { id });
  const action = (id: string, actionString: string) =>
    onEvent("action", { id, action: actionString });

  return (
    <div className="ae-notification-stack" aria-live="polite">
      {list.map((n) => {
        const kind: NotificationKind = n.kind ?? "info";
        return (
          <div
            key={n.id}
            className={`ae-notification ae-notification-${kind}`}
            role="status"
          >
            <span className="ae-notification-glyph" aria-hidden="true">
              {KIND_GLYPH[kind]}
            </span>
            <div className="ae-notification-body">
              <div className="ae-notification-title">{n.title}</div>
              {n.message ? (
                <div className="ae-notification-message">{n.message}</div>
              ) : null}
              {n.actions && n.actions.length > 0 ? (
                <div className="ae-notification-actions">
                  {n.actions.map((a) => (
                    <button
                      key={a.action}
                      type="button"
                      className="ae-notification-action"
                      onClick={() => action(n.id, a.action)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="ae-notification-close"
              aria-label="Dismiss"
              onClick={() => dismiss(n.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
