import { useRef } from "react";

/** Lifetime of an Allow/Deny prompt for `aethon.shells.write` in
 *  read-write mode. Set ~30 s under the bridge-side ack timeout
 *  (5 min) so a late click can never inject keystrokes after the
 *  caller's promise has already failed with `timeout`. The auto-
 *  expire flows through the existing notification dismiss path,
 *  which resolves the consent as deny. */
const SHELL_WRITE_PROMPT_TTL_MS = 4 * 60 * 1000 + 30 * 1000;

interface NotificationAction {
  label: string;
  action: string;
}

interface NotificationInput {
  id: string;
  title: string;
  message?: string;
  kind?: "info" | "success" | "warning" | "error";
  durationMs?: number | null;
  actions?: NotificationAction[];
}

export interface UseShellConsentContext {
  pushNotification: (n: NotificationInput) => void;
}

export interface UseShellConsentActions {
  resolveShellWriteConsent: (notifId: string, allowed: boolean) => void;
  resolveShellCloseConsent: (notifId: string, allowed: boolean) => void;
  resolveSessionDeleteConsent: (notifId: string, allowed: boolean) => void;
  hasPendingShellWriteConsent: (notifId: string) => boolean;
  hasPendingShellCloseConsent: (notifId: string) => boolean;
  hasPendingSessionDeleteConsent: (notifId: string) => boolean;
  promptShellWriteConfirmation: (input: {
    tabId: string;
    text: string;
    tabLabel: string;
  }) => Promise<boolean>;
  promptCloseShellTabConfirmation: (tabLabel: string) => Promise<boolean>;
  promptDeleteSessionConfirmation: (label: string) => Promise<boolean>;
}

/**
 * The Allow/Deny prompt machinery for the three shell-related consent
 * flows: agent-driven `shell_write` (read-write mode), interactive
 * close of a running shell tab, and on-disk session deletion.
 *
 * Each flow has the same shape: a Map keyed by notification id holds
 * the pending Promise resolver. The notification action route (in
 * App.tsx's onEvent) calls the matching `resolve*Consent` to settle
 * the Promise. Dismissal flows through the same path with `false` so
 * a vanished prompt is treated as Deny — defense in depth against the
 * agent waiting forever on a closed prompt.
 *
 * Trust boundary: the actual security check lives in Rust
 * (`shell_write` Tauri command re-validates the share mode) — these
 * prompts are UX gates, not the privacy boundary itself.
 */
export function useShellConsent(
  ctx: UseShellConsentContext,
): UseShellConsentActions {
  /** Pending agent-write confirmations keyed by notification id. */
  const shellWriteConsentRef = useRef<Map<string, (allowed: boolean) => void>>(
    new Map(),
  );
  /** Pending close-shell-tab confirmations keyed off notification id. */
  const shellCloseConsentRef = useRef<
    Map<string, (allowed: boolean) => void>
  >(new Map());
  /** Pending session-deletion confirmations keyed off notification id. */
  const sessionDeleteConsentRef = useRef<
    Map<string, (allowed: boolean) => void>
  >(new Map());

  function resolveShellWriteConsent(notifId: string, allowed: boolean) {
    const resolve = shellWriteConsentRef.current.get(notifId);
    if (!resolve) return;
    shellWriteConsentRef.current.delete(notifId);
    resolve(allowed);
  }

  function resolveShellCloseConsent(notifId: string, allowed: boolean) {
    const resolve = shellCloseConsentRef.current.get(notifId);
    if (!resolve) return;
    shellCloseConsentRef.current.delete(notifId);
    resolve(allowed);
  }

  function resolveSessionDeleteConsent(notifId: string, allowed: boolean) {
    const resolve = sessionDeleteConsentRef.current.get(notifId);
    if (!resolve) return;
    sessionDeleteConsentRef.current.delete(notifId);
    resolve(allowed);
  }

  function hasPendingShellWriteConsent(notifId: string): boolean {
    return shellWriteConsentRef.current.has(notifId);
  }
  function hasPendingShellCloseConsent(notifId: string): boolean {
    return shellCloseConsentRef.current.has(notifId);
  }
  function hasPendingSessionDeleteConsent(notifId: string): boolean {
    return sessionDeleteConsentRef.current.has(notifId);
  }

  /** Push an Allow/Deny notification and resolve with the user's choice
   *  (or `false` on dismiss / auto-expire). */
  function promptShellWriteConfirmation(input: {
    tabId: string;
    text: string;
    tabLabel: string;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `shell-write-${crypto.randomUUID().slice(0, 8)}`;
      shellWriteConsentRef.current.set(id, resolve);
      // Truncate the preview — agents can ask for long pastes; we want
      // the notification to stay scannable. The full text still goes
      // to the PTY on Allow.
      const preview = input.text.length > 80
        ? `${input.text.slice(0, 80).replace(/\n/g, "⏎")}…`
        : input.text.replace(/\n/g, "⏎");
      ctx.pushNotification({
        id,
        title: `Agent wants to type in "${input.tabLabel}"`,
        message: preview,
        kind: "warning",
        // Auto-expire ~30 s before the bridge's 5-min ack timeout so a
        // late Allow click can never invoke `shell_write` after the
        // caller's promise has already resolved as timed-out.
        durationMs: SHELL_WRITE_PROMPT_TTL_MS,
        actions: [
          { label: "Allow", action: `shell-write-allow:${id}` },
          { label: "Deny", action: `shell-write-deny:${id}` },
        ],
      });
    });
  }

  /** Pop a Close / Cancel notification before tearing down a running
   *  shell tab. Resolves true → caller proceeds with `closeTabNow`,
   *  false → caller bails. Sticky (durationMs: null) so the destructive
   *  action requires a deliberate click. */
  function promptCloseShellTabConfirmation(
    tabLabel: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `shell-close-${crypto.randomUUID().slice(0, 8)}`;
      shellCloseConsentRef.current.set(id, resolve);
      ctx.pushNotification({
        id,
        title: `Close "${tabLabel}"?`,
        message:
          "The shell is still running. Closing terminates it (SIGTERM, then SIGKILL after 5s).",
        kind: "warning",
        durationMs: null,
        actions: [
          { label: "Close", action: `shell-close-allow:${id}` },
          { label: "Cancel", action: `shell-close-deny:${id}` },
        ],
      });
    });
  }

  /** Pop a Delete / Cancel notification before removing a saved session.
   *  Sticky toast (durationMs: null) so a destructive action requires
   *  a deliberate click. */
  function promptDeleteSessionConfirmation(
    label: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `session-delete-${crypto.randomUUID().slice(0, 8)}`;
      sessionDeleteConsentRef.current.set(id, resolve);
      ctx.pushNotification({
        id,
        title: `Delete saved session?`,
        message: `"${label}" — the on-disk transcript will be removed and cannot be recovered.`,
        kind: "warning",
        durationMs: null,
        actions: [
          { label: "Delete", action: `session-delete-allow:${id}` },
          { label: "Cancel", action: `session-delete-deny:${id}` },
        ],
      });
    });
  }

  return {
    resolveShellWriteConsent,
    resolveShellCloseConsent,
    resolveSessionDeleteConsent,
    hasPendingShellWriteConsent,
    hasPendingShellCloseConsent,
    hasPendingSessionDeleteConsent,
    promptShellWriteConfirmation,
    promptCloseShellTabConfirmation,
    promptDeleteSessionConfirmation,
  };
}
