import { listen } from "@tauri-apps/api/event";
import type { Tab } from "../../types/tab";
import { TERMINAL_REPLAY_MAX } from "../useTabs";

export interface ShellStreamsDeps {
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
}

/** How long PTY chunks accumulate before one state flush. The xterm gets
 *  every chunk immediately via the DOM event; the state write only feeds
 *  the replay buffer, so ~10 renders/sec is plenty. Without coalescing a
 *  busy shell (build output) caused hundreds of full-tree React renders
 *  per second — `updateTab` ran per PTY chunk. */
export const SHELL_BUFFER_FLUSH_MS = 100;

/** Closure-scoped coalescer for terminalBuffer appends. Pure-ish and
 *  exported for tests: `flush()` applies all pending chunks through
 *  `updateTab` in one pass per tab. */
export function createShellOutputCoalescer(
  updateTab: ShellStreamsDeps["updateTab"],
  flushMs: number = SHELL_BUFFER_FLUSH_MS,
) {
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushTab = (tabId: string) => {
    const chunk = pending.get(tabId);
    if (chunk === undefined) return;
    pending.delete(tabId);
    updateTab(tabId, (t) => {
      const next = t.terminalBuffer + chunk;
      const trimmed =
        next.length > TERMINAL_REPLAY_MAX
          ? next.slice(next.length - TERMINAL_REPLAY_MAX)
          : next;
      return { ...t, terminalBuffer: trimmed };
    });
  };

  const flushAll = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const tabId of [...pending.keys()]) flushTab(tabId);
  };

  return {
    /** Queue a chunk; schedules a flush if one isn't already pending. */
    push(tabId: string, content: string) {
      // Cap the pending chunk itself — anything beyond the replay max
      // would be sliced away at flush time anyway, and an unbounded
      // pending string is exactly the kind of buffer this module exists
      // to avoid.
      const next = (pending.get(tabId) ?? "") + content;
      pending.set(
        tabId,
        next.length > TERMINAL_REPLAY_MAX
          ? next.slice(next.length - TERMINAL_REPLAY_MAX)
          : next,
      );
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          flushAll();
        }, flushMs);
      }
    },
    /** Flush one tab synchronously (shell exit must not race the buffer). */
    flushTab,
    /** Flush everything and cancel the timer (unsubscribe path). */
    flushAll,
  };
}

/** PTY stream listeners: `shell-output` appends to the tab's
 *  terminalBuffer (trimmed to TERMINAL_REPLAY_MAX, coalesced to one state
 *  write per SHELL_BUFFER_FLUSH_MS) and dispatches a per-tab DOM event so
 *  the shell-canvas composite writes the chunk to its xterm immediately.
 *  `shell-exit` flips the tab's shellState to "exited" with the exit
 *  code. `shell-title` mirrors OSC 0/1/2 title-set sequences into the tab
 *  label (truncated to 64 chars).
 *
 *  Inactive shell-tab output stays buffered until the user switches
 *  to it — the canvas replays on mount, matching the read-only
 *  Terminal panel's agent-bash buffering. */
export function subscribeShellStreams(deps: ShellStreamsDeps): () => void {
  const { updateTab } = deps;
  const coalescer = createShellOutputCoalescer(updateTab);

  const unlistenShellOutput = listen<{ tabId: string; content: string }>(
    "shell-output",
    (event) => {
      const { tabId, content } = event.payload;
      if (!tabId || typeof content !== "string") return;
      coalescer.push(tabId, content);
      window.dispatchEvent(
        new CustomEvent(`aethon:shell-output:${tabId}`, { detail: content }),
      );
    },
  );

  const unlistenShellExit = listen<{ tabId: string; code: number | null }>(
    "shell-exit",
    (event) => {
      const { tabId, code } = event.payload;
      if (!tabId) return;
      // The final output chunks must land in the replay buffer before the
      // exited state renders (replay/persist read the buffer).
      coalescer.flushTab(tabId);
      updateTab(tabId, (t) => {
        if (t.kind !== "shell" || !t.shell) return t;
        return {
          ...t,
          shell: {
            ...t.shell,
            shellState: "exited",
            ...(typeof code === "number" ? { exitCode: code } : {}),
          },
        };
      });
    },
  );

  const unlistenShellTitle = listen<{ tabId: string; title: string }>(
    "shell-title",
    (event) => {
      const { tabId, title } = event.payload;
      if (!tabId || typeof title !== "string" || title.length === 0) return;
      const safe = title.length > 64 ? `${title.slice(0, 61)}…` : title;
      updateTab(tabId, (t) => {
        if (t.kind !== "shell" || t.label === safe) return t;
        return { ...t, label: safe };
      });
    },
  );

  return () => {
    coalescer.flushAll();
    unlistenShellOutput.then((fn) => fn());
    unlistenShellExit.then((fn) => fn());
    unlistenShellTitle.then((fn) => fn());
  };
}
