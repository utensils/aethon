import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { Tab } from "../types/tab";
import type {
  NotificationEntry,
  NotificationKind,
} from "../extensions/default-layout/notifications";

export interface NotificationInput {
  id?: string;
  title: string;
  message?: string;
  kind?: NotificationKind;
  durationMs?: number | null;
  actions?: { label: string; action: string }[];
}

export interface UseNotificationsContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  /** Live config from `[ui] notify_on_completion`. */
  notifyOnCompletionRef: MutableRefObject<boolean>;
  /** Live config from `[ui] notify_min_duration_seconds * 1000`. */
  notifyMinDurationMsRef: MutableRefObject<number>;
  /** When pushNotification's dedupe / cap eviction silently drops a
   *  pending consent notification, fire its resolver as `false` so the
   *  awaiting caller doesn't dangle. */
  resolveShellWriteConsent: (id: string, allowed: boolean) => void;
  resolveShellCloseConsent: (id: string, allowed: boolean) => void;
  resolveWorktreePrompt: (id: string, allowed: boolean) => void;
}

export interface UseNotificationsActions {
  pushNotification: (input: NotificationInput) => string;
  dismissNotification: (id: string) => void;
  maybeFireCompletionNotification: (input: {
    tabId: string;
    turnDurationMs: number;
  }) => Promise<void>;
}

const MAX_VISIBLE = 6;

/**
 * Toast stack rendered at App root. Used for mutation feedback (theme
 * set, layout switched), agent-pushed `notice`s, and OS-level completion
 * notifications. Stays out of chat history so the conversation surface
 * isn't cluttered with UI bookkeeping.
 *
 * Dedupe: notifications are keyed by id; pushing with an existing id
 * replaces the visible entry rather than stacking. Visible cap is 6 —
 * a runaway extension can't spam toasts off-screen. Both eviction
 * paths fire any pending shell-write / shell-close consent resolvers
 * with `false` so the originator promise doesn't dangle.
 */
export function useNotifications(
  ctx: UseNotificationsContext,
): UseNotificationsActions {
  const {
    setState,
    stateRef,
    notifyOnCompletionRef,
    notifyMinDurationMsRef,
    resolveShellWriteConsent,
    resolveShellCloseConsent,
    resolveWorktreePrompt,
  } = ctx;

  function pushNotification(input: NotificationInput): string {
    const id = input.id ?? crypto.randomUUID();
    const entry: NotificationEntry = {
      id,
      title: input.title,
      ...(input.message ? { message: input.message } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      // Default to a 4 s auto-dismiss for transient feedback. Pass
      // `null` to make a notification sticky (warnings with actions
      // typically want this).
      durationMs:
        input.durationMs === null
          ? null
          : (input.durationMs ?? 4000),
      ...(input.actions && input.actions.length > 0
        ? { actions: input.actions }
        : {}),
      createdAt: Date.now(),
    };
    setState((prev) => {
      const list = (prev.notifications as NotificationEntry[] | undefined) ?? [];
      // Dedup by id — if a notification with the same id is already
      // visible, replace it. Lets repeated triggers (rapid ⌘+/-,
      // burst mutation feedback) refresh the toast in place rather
      // than stack 5 copies.
      const without = list.filter((n) => n.id !== entry.id);
      // Cap the visible stack so a runaway extension can't spam toasts
      // off-screen. Newest wins; the oldest beyond the cap is dropped.
      const next = [...without, entry];
      const trimmed = next.length > MAX_VISIBLE ? next.slice(-MAX_VISIBLE) : next;
      // Drop side effect: any pending consent prompts that just got
      // silently evicted (dedup or trim) need their resolver fired so
      // the originator promise doesn't dangle. Both shell-write
      // (5-min bridge timeout) and shell-close (Cmd+W → tab stays
      // alive) need this guarantee.
      const survivedIds = new Set(trimmed.map((n) => n.id));
      for (const n of list) {
        if (!survivedIds.has(n.id)) {
          resolveShellWriteConsent(n.id, false);
          resolveShellCloseConsent(n.id, false);
          resolveWorktreePrompt(n.id, false);
        }
      }
      return { ...prev, notifications: trimmed };
    });
    return id;
  }

  function dismissNotification(id: string) {
    setState((prev) => {
      const list = (prev.notifications as NotificationEntry[] | undefined) ?? [];
      return { ...prev, notifications: list.filter((n) => n.id !== id) };
    });
  }

  /** Agent turn-completion alert. Gated on `[ui] notify_on_completion` and
   *  a minimum turn duration, then split by where the user's attention is:
   *
   *    • focused + originating tab active  → nothing (they see the result).
   *    • focused + a different tab/workspace → in-app toast that deep-links
   *      back to the finished session (less disruptive than an OS banner
   *      while the window is up).
   *    • window unfocused → native OS notification (shows even when the
   *      app is hidden; permission requested lazily on first fire).
   *
   *  Both surfaces read "ready for your reply" so a completed-and-idle
   *  agent is legible as "your turn", not just "done". The originating tab
   *  may live in a stashed bucket (a background workspace), so its label
   *  falls back to a generic when it isn't in `state.tabs`. */
  async function maybeFireCompletionNotification(input: {
    tabId: string;
    turnDurationMs: number;
  }) {
    if (!notifyOnCompletionRef.current) return;
    if (input.turnDurationMs < notifyMinDurationMsRef.current) return;
    const windowFocused = typeof document !== "undefined" && document.hasFocus();
    const isActiveTab = stateRef.current.activeTabId === input.tabId;
    if (windowFocused && isActiveTab) return;

    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const tab = tabs.find((t) => t.id === input.tabId);
    const lastMsg = tab?.messages?.at(-1);
    const snippet =
      typeof lastMsg?.text === "string" && lastMsg.text.length > 0
        ? lastMsg.text.slice(0, 120)
        : "Turn complete.";

    if (windowFocused) {
      // The window is up but the user is elsewhere — an in-app toast that
      // jumps to the finished session beats an OS banner here.
      pushNotification({
        id: `agent-complete:${input.tabId}`,
        title: tab?.label
          ? `${tab.label} — ready for your reply`
          : "Agent ready for your reply",
        message: snippet,
        kind: "success",
        durationMs: 6000,
        actions: [{ label: "View", action: `activate-tab:${input.tabId}` }],
      });
      return;
    }

    try {
      const notif = await import("@tauri-apps/plugin-notification");
      let granted = await notif.isPermissionGranted();
      if (!granted) {
        const perm = await notif.requestPermission();
        granted = perm === "granted";
      }
      if (!granted) return;
      notif.sendNotification({
        title: tab?.label ? `${tab.label} — ready` : "Aethon — ready",
        body: snippet,
      });
    } catch (err) {
      console.warn("notification fire failed:", err);
    }
  }

  return {
    pushNotification,
    dismissNotification,
    maybeFireCompletionNotification,
  };
}
