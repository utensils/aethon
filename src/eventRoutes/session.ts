import type { EventRouteHandler } from "./types";
import type { ChatMessage } from "../types/a2ui";
import { truncateToEntry } from "../utils/messages";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const pendingForks = new Set<string>();
const FORK_DEBOUNCE_MS = 60_000;

function trackPendingFork(key: string) {
  pendingForks.add(key);
  const timer = globalThis.setTimeout(() => {
    pendingForks.delete(key);
  }, FORK_DEBOUNCE_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function clearPendingForksForTab(tabId: string) {
  for (const key of Array.from(pendingForks)) {
    if (key.startsWith(`${tabId}:`)) pendingForks.delete(key);
  }
}

/**
 * Rollback / fork affordances fired from a transcript row (the per-message
 * hover toolbar in the chat-history / main-canvas surfaces).
 *
 *  - `rollback-to-here`: optimistically truncate the rendered transcript to the
 *    chosen message, then ask the bridge to branch the session there. The
 *    bridge's `session_rolled_back` reply reconciles authoritatively.
 *  - `fork-to-tab`: copy the SQLite-backed transcript path directly through
 *    Rust and open the new tab from the command result. This is intentionally
 *    not routed through the agent bridge because a busy LLM turn must not make
 *    a local transcript fork feel stuck.
 *
 * Both are keyed off `entryId` (the pi session entry id carried on the row).
 */
interface ForkSessionResult {
  tabId?: string;
  newTabId?: string;
  label?: string;
  cwd?: string;
  messages?: ChatMessage[];
}

export const handleSessionBranch: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  const record =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const entryId = str(record.entryId);
  const explicitTabId = str(record.tabId);
  const cwd = str(record.cwd);
  const targetTabId = () =>
    explicitTabId || str(ctx.stateRef.current.activeTabId);

  if (eventType === "rollback-to-here") {
    if (!entryId) return false;
    const tabId = targetTabId();
    if (!tabId) return false;
    ctx.updateTab(tabId, (tab) => {
      const messages = truncateToEntry(tab.messages, entryId);
      return messages === tab.messages
        ? tab
        : { ...tab, messages, waiting: false };
    });
    void ctx.invoke("agent_command", {
      payload: JSON.stringify({
        type: "rollback_session",
        tabId,
        entryId,
        ...(cwd ? { cwd } : {}),
      }),
    });
    return true;
  }

  if (eventType === "fork-to-tab") {
    if (!entryId) return false;
    const tabId = targetTabId();
    if (!tabId) return false;
    const forkKey = `${tabId}:${entryId}`;
    if (pendingForks.has(forkKey)) return true;
    trackPendingFork(forkKey);
    ctx.pushNotification({
      id: `session-fork-${tabId}`,
      title: "Forking session",
      message: "Creating a new tab from this turn...",
      kind: "info",
      durationMs: null,
    });
    void ctx
      .invoke("fork_session", {
        tabId,
        entryId,
        ...(cwd ? { cwd } : {}),
      })
      .then((result) => {
        const forked = result as ForkSessionResult | undefined;
        const newTabId =
          typeof forked?.newTabId === "string" ? forked.newTabId : "";
        if (!newTabId) throw new Error("fork_session: missing forked tab id");
        const label =
          typeof forked?.label === "string" && forked.label.trim()
            ? forked.label
            : "Fork";
        const resultCwd =
          typeof forked?.cwd === "string" && forked.cwd.trim()
            ? forked.cwd
            : cwd || undefined;
        clearPendingForksForTab(tabId);
        ctx.dismissNotification(`session-fork-${tabId}`);
        ctx.newTab(newTabId, label, {
          restoredSession: true,
          ...(resultCwd ? { cwd: resultCwd } : {}),
        });
        if (Array.isArray(forked?.messages) && forked.messages.length > 0) {
          ctx.updateTab(newTabId, (tab) => ({
            ...tab,
            messages: forked.messages as ChatMessage[],
          }));
        }
        ctx.pushNotification({
          title: "Forked session",
          message: `Opened ${label}.`,
          kind: "success",
          durationMs: 3000,
        });
      })
      .catch((err: unknown) => {
        pendingForks.delete(forkKey);
        ctx.dismissNotification(`session-fork-${tabId}`);
        ctx.pushNotification({
          title: "Fork failed",
          message: err instanceof Error ? err.message : String(err),
          kind: "error",
          durationMs: 5000,
        });
      });
    return true;
  }

  return false;
};
